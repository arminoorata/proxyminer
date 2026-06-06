/**
 * Ingestion service — TS port of
 * /srv/projects/ProxyMiner/apps/api/app/services/ingest.py
 *
 * Flow per company:
 *   1. Resolve ticker → CIK (via SEC company tickers).
 *   2. Fetch /submissions/CIK<padded>.json.
 *   3. Filter to recent DEF 14A filings, take ≤ limit.
 *   4. For each filing:
 *      a. Fetch the filing index, find the primary document.
 *      b. Fetch the primary HTML.
 *      c. Store both in Vercel Blob.
 *      d. Run extractors (CD&A, exec comp, peer, fact).
 *      e. Persist company / filing / artifacts in Postgres,
 *         replacing prior extractions wholesale (matches Python
 *         "destructive replace" model).
 *      f. Record an ingest_jobs row with status.
 *
 * Memory safety (April 2026 OOM lessons): each filing's HTML is
 * dropped before the next iteration; cheerio trees are not retained.
 *
 * STATUS: scaffold. Persistence is wired to Postgres only when
 * DATABASE_URL is set; otherwise this throws early and tells the
 * caller to provision Neon (User-Action A-002).
 */
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { putArtifact } from "@/lib/blob/client";
import { SecClient } from "@/lib/extractors/sec-client";
import { extractCdAndA } from "@/lib/extractors/cd-and-a";
import { extractExecutiveCompensation } from "@/lib/extractors/executive-comp";
import {
  extractPeerGroups,
  extractPeerGroupsFromHtmlTables,
  extractPeerGroupsFromSuffixEnumeration,
  extractPeerGroupsFromTickerInline,
} from "@/lib/extractors/peer-groups";
import { getSecTickers } from "@/lib/services/sec-tickers-cache";
import {
  discoverTargetFilings,
  type SecSubmissionsBlock,
} from "@/lib/services/sec-filing-discovery";
import { mergePeerGroups } from "@/lib/services/merge-peer-groups";
import { extractFactsFromSections } from "@/lib/extractors/facts";
import { extractProxySections } from "@/lib/extractors/proxy-sections";

export type IngestProgressPhase =
  | "resolving"
  | "fetching"
  | "extracting"
  | "saving";

export interface IngestProgressUpdate {
  phase: IngestProgressPhase;
  company_id?: string | null;
  filings_processed?: number;
  filings_total?: number;
  current_filing?: string;
}

interface IngestOptions {
  limit?: number;
  /**
   * Override the audit row written at the end. Used by the synchronous
   * admin/public path to tag the job as `public_ingest` and attach
   * the hashed client identifier. Ignored when `audit_job_id` is set
   * (durable path: the caller already inserted a row and will finalize
   * it).
   */
  audit?: {
    job_type?: string;
    client_hash?: string;
  };
  /**
   * Existing `ingest_jobs.id` to finalize against. When set, this
   * function does NOT insert a new audit row — the caller owns the
   * row lifecycle (durable / `after()` path).
   */
  audit_job_id?: number;
  /**
   * Called when entering each major phase. The durable path uses
   * this to update job status in real time so the front-end poller
   * can render progress.
   */
  onProgress?: (update: IngestProgressUpdate) => Promise<void> | void;
}

interface IngestResult {
  identifier: string;
  company_id: string | null;
  filings_processed: number;
  errors: string[];
}

const TARGET_FORM_TYPES = new Set(["DEF 14A"]);

export async function ingestCompany(
  identifier: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "ingestCompany requires DATABASE_URL (Neon). See User-Action A-002.",
    );
  }
  const limit = opts.limit ?? 2;
  const sec = new SecClient();
  const errors: string[] = [];
  const onProgress = opts.onProgress;
  const emit = async (update: IngestProgressUpdate) => {
    if (!onProgress) return;
    try {
      await onProgress(update);
    } catch (err) {
      // Progress updates are best-effort; never fail the ingest because the
      // status row couldn't be touched.
      console.warn("[ingest] onProgress failed:", err);
    }
  };

  // 1. Resolve identifier → CIK + company info. Backed by the shared
  // SEC tickers cache so a hot autocomplete keystroke and a hot ingest
  // share the same in-memory snapshot.
  await emit({ phase: "resolving" });
  const cache = await getSecTickers();
  const upperLower = identifier.toLowerCase();
  const cikPadded = identifier.padStart(10, "0");
  const tickerEntry =
    cache.byTickerLower.get(upperLower) ?? cache.byCik.get(cikPadded);
  if (!tickerEntry) {
    throw new Error(`could not resolve identifier ${identifier}`);
  }
  const cik = tickerEntry.cik;
  const companyId = tickerEntry.ticker_lower;

  // 2. Upsert company row.
  await db()
    .insert(schema.companies)
    .values({
      id: companyId,
      cik,
      ticker: tickerEntry.ticker,
      name: tickerEntry.name,
    })
    .onConflictDoUpdate({
      target: schema.companies.id,
      set: { ticker: tickerEntry.ticker, name: tickerEntry.name, updated_at: new Date() },
    });

  // 3. Submissions JSON. DEF 14A discovery fills beyond `filings.recent`
  // into the paginated `filings.files` archive ONLY when `recent` is short,
  // so a proxy that has aged out of `recent` (e.g. Meta's 2024 DEF 14A) is
  // still reachable. Companies whose `recent` already satisfies `limit` keep
  // the exact prior behavior and fetch no archive files.
  const subs = await sec.fetchJson<{
    name: string;
    cik: string;
    tickers: string[];
    filings: {
      recent: SecSubmissionsBlock;
      files?: {
        name: string;
        filingCount?: number;
        filingFrom?: string;
        filingTo?: string;
      }[];
    };
  }>(sec.submissionsUrl(cik));
  const matching = await discoverTargetFilings({
    recent: subs.filings.recent,
    archiveFiles: subs.filings.files,
    limit,
    targetForms: TARGET_FORM_TYPES,
    fetchArchive: (name) =>
      sec.fetchJson<SecSubmissionsBlock>(sec.submissionsArchiveUrl(name)),
  });

  // 4. Per filing
  let processed = 0;
  const filingsTotal = matching.length;
  for (const f of matching) {
    try {
      const filingId = f.accession.replace(/-/g, "");
      await emit({
        phase: "fetching",
        company_id: companyId,
        filings_processed: processed,
        filings_total: filingsTotal,
        current_filing: f.accession,
      });
      const docUrl = sec.filingDocumentUrl(cik, f.accession, f.primaryDocument);
      let html = await sec.fetchText(docUrl);
      const blob = await putArtifact(`${companyId}/${filingId}/${f.primaryDocument}`, html);

      // Persist filing + document
      await db()
        .insert(schema.filings)
        .values({
          id: filingId,
          company_id: companyId,
          accession_number: f.accession,
          form_type: f.form,
          filing_date: new Date(f.filingDate),
          filing_year: new Date(f.filingDate).getUTCFullYear(),
          source_index_url: sec.filingIndexUrl(cik, f.accession),
          primary_document_url: docUrl,
          primary_document_name: f.primaryDocument,
        })
        .onConflictDoNothing();

      // Run extractors
      await emit({
        phase: "extracting",
        company_id: companyId,
        filings_processed: processed,
        filings_total: filingsTotal,
        current_filing: f.accession,
      });
      const cda = extractCdAndA(html);
      const execRows = extractExecutiveCompensation(html);
      const cdaText = cda?.text ?? "";
      // Run both text-based (CD&A) and HTML-table peer extractors,
      // then merge — deduping groups whose member sets overlap so a
      // filing whose peer list appears both in CD&A prose and an HTML
      // table only produces one row. Text extractor is the primary
      // source (≥7-member quality guard built in); HTML-table
      // extractor only fires for tables preceded by a peer-group
      // intro phrase (NFLX, IDXX, PNC, PSA, HUBB style).
      const peersFromText = extractPeerGroups(filingId, cdaText);
      const peersFromHtml = extractPeerGroupsFromHtmlTables(filingId, html);
      const peersFromInline = extractPeerGroupsFromTickerInline(filingId, html);
      const peersFromSuffix = extractPeerGroupsFromSuffixEnumeration(
        filingId,
        html,
      );
      // Text extractor is the primary; HTML-table fallback fills in
      // structured-table filers; ticker-inline catches iXBRL-positioned
      // `Name (TICKER)` runs (TGT, MA, HBAN); suffix-enumeration
      // catches comma- or whitespace-separated runs of corporate-
      // suffix names (DIS, WMT). Each merge step drops groups whose
      // member set overlaps ≥60% with anything already in the result,
      // so a filing surfacing the same peers via multiple shapes only
      // produces one row.
      const merged1 = mergePeerGroups(peersFromText, peersFromHtml);
      const merged2 = mergePeerGroups(merged1, peersFromInline);
      const peers = mergePeerGroups(merged2, peersFromSuffix);
      const proxySections = extractProxySections(html);

      // Build a unified section list for fact extraction. CD&A is the
      // primary source; the dedicated sections (pay ratio, say on
      // pay, committee report) fill gaps for facts CD&A didn't cover.
      const sectionInputs: { section_type: string; text: string; heading?: string | null }[] = [];
      if (cda) sectionInputs.push({ section_type: "cd_and_a", text: cda.text, heading: cda.heading });
      for (const s of proxySections) {
        sectionInputs.push({
          section_type: s.section_type,
          text: s.section.text,
          heading: s.section.heading,
        });
      }
      const facts = extractFactsFromSections(filingId, sectionInputs);

      // Replace-wholesale persist (matches Python).
      await emit({
        phase: "saving",
        company_id: companyId,
        filings_processed: processed,
        filings_total: filingsTotal,
        current_filing: f.accession,
      });
      // Sections — write one row per extracted section type.
      await db().delete(schema.sections).where(eq(schema.sections.filing_id, filingId));
      if (cda) {
        await db().insert(schema.sections).values({
          filing_id: filingId,
          section_type: "cd_and_a",
          heading: cda.heading,
          normalized_heading: cda.heading.toLowerCase(),
          text: cda.text,
          html_fragment: cda.html_fragment,
          confidence_score: cda.confidence_score.toFixed(3) as unknown as string,
          extractor_version: "cda_extractor.ts.v1",
          extraction_method: cda.method,
          source_document_name: f.primaryDocument,
          source_document_sha: null,
        });
      }
      for (const s of proxySections) {
        await db().insert(schema.sections).values({
          filing_id: filingId,
          section_type: s.section_type,
          heading: s.section.heading,
          normalized_heading: s.section.heading.toLowerCase(),
          text: s.section.text,
          html_fragment: s.section.html_fragment,
          confidence_score: s.section.confidence_score.toFixed(3) as unknown as string,
          extractor_version: s.extractor_version,
          extraction_method: s.section.method,
          source_document_name: f.primaryDocument,
          source_document_sha: null,
        });
      }

      // Executive comp rows
      await db().delete(schema.exec_comp_rows).where(eq(schema.exec_comp_rows.filing_id, filingId));
      if (execRows.length > 0) {
        await db().insert(schema.exec_comp_rows).values(
          execRows.map((r) => ({
            filing_id: filingId,
            executive_name: r.executive_name,
            principal_position: r.principal_position,
            year: r.year,
            salary: r.salary,
            bonus: r.bonus,
            stock_awards: r.stock_awards,
            option_awards: r.option_awards,
            non_equity_incentive_plan_compensation: r.non_equity_incentive_plan_compensation,
            all_other_compensation: r.all_other_compensation,
            total: r.total,
            source_excerpt: r.source_excerpt,
            extractor_version: "executive_comp_extractor.ts.v1",
            extraction_method: "summary-comp-table",
            source_document_name: f.primaryDocument,
          })),
        );
      }

      // Peer groups (cascading members handled by FK).
      // Look up which resolved peer company IDs are tracked in our
      // companies table — others must be nulled to satisfy the FK on
      // peer_group_members.company_id_resolved.
      const trackedRows = await db().select({ id: schema.companies.id }).from(schema.companies);
      const trackedCompanyIds = new Set(trackedRows.map((r) => r.id));
      await db().delete(schema.peer_groups).where(eq(schema.peer_groups.filing_id, filingId));
      for (const g of peers) {
        const [inserted] = await db()
          .insert(schema.peer_groups)
          .values({
            filing_id: g.filing_id,
            peer_group_name: g.peer_group_name,
            peer_group_type: g.peer_group_type,
            disclosed_year: g.disclosed_year,
            selection_rationale: g.selection_rationale,
            source_excerpt: g.source_excerpt,
            confidence_score: g.confidence_score?.toFixed(3) as unknown as string,
            extractor_version: g.extractor_version,
            extraction_method: g.extraction_method,
            source_document_name: f.primaryDocument,
          })
          .returning({ id: schema.peer_groups.id });
        if (g.members.length > 0 && inserted) {
          await db().insert(schema.peer_group_members).values(
            g.members.map((m) => ({
              peer_group_id: inserted.id,
              company_name_raw: m.company_name_raw,
              company_id_resolved:
                m.company_id_resolved && trackedCompanyIds.has(m.company_id_resolved)
                  ? m.company_id_resolved
                  : null,
              company_name_resolved: m.company_name_resolved,
              ticker_resolved: m.ticker_resolved,
              cik_resolved: m.cik_resolved,
              resolution_confidence:
                m.resolution_confidence?.toFixed(3) as unknown as string,
            })),
          );
        }
      }

      // Policy + metric facts
      await db().delete(schema.policy_facts).where(eq(schema.policy_facts.filing_id, filingId));
      if (facts.policies.length > 0) {
        await db()
          .insert(schema.policy_facts)
          .values(
            facts.policies.map((p) => ({
              filing_id: p.filing_id,
              policy_type: p.policy_type,
              normalized_value: p.normalized_value,
              summary: p.summary,
              source_excerpt: p.source_excerpt,
              confidence_score: p.confidence_score?.toFixed(3) as unknown as string,
              extractor_version: p.extractor_version,
              extraction_method: p.extraction_method,
              source_document_name: f.primaryDocument,
            })),
          );
      }
      await db().delete(schema.metric_facts).where(eq(schema.metric_facts.filing_id, filingId));
      if (facts.metrics.length > 0) {
        await db()
          .insert(schema.metric_facts)
          .values(
            facts.metrics.map((m) => ({
              filing_id: m.filing_id,
              metric_name_raw: m.metric_name_raw,
              metric_name_normalized: m.metric_name_normalized,
              metric_category: m.metric_category,
              plan_type: m.plan_type,
              observed_value: m.observed_value,
              source_excerpt: m.source_excerpt,
              confidence_score: m.confidence_score?.toFixed(3) as unknown as string,
              extractor_version: m.extractor_version,
              extraction_method: m.extraction_method,
              source_document_name: f.primaryDocument,
            })),
          );
      }

      // Memory: drop the HTML reference now (cheerio is already done).
      html = "";
      void blob; // url already persisted
      processed += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Audit trail: when the caller owns the job row (durable path via
  // `after()`), they finalize it themselves. We only insert a fresh
  // row in the synchronous admin path that doesn't pass `audit_job_id`.
  if (opts.audit_job_id === undefined) {
    const auditJobType = opts.audit?.job_type ?? "company_backfill";
    const auditDetail: Record<string, unknown> = { errors };
    if (opts.audit?.client_hash) auditDetail.client_hash = opts.audit.client_hash;
    await db().insert(schema.ingest_jobs).values({
      job_type: auditJobType,
      status: errors.length > 0 ? (processed > 0 ? "partial" : "failed") : "ok",
      identifier,
      note: `processed=${processed} errors=${errors.length}`,
      detail: auditDetail,
      completed_at: new Date(),
    });
  }

  return { identifier, company_id: companyId, filings_processed: processed, errors };
}
