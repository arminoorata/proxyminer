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
} from "@/lib/extractors/peer-groups";
import type { PeerGroupRow } from "@/lib/types";

type ExtractedPeerGroup = Omit<PeerGroupRow, "id" | "section_id">;

/**
 * Merge peer groups extracted via CD&A text and HTML-table paths.
 * Drops a "secondary" group whose member set shares >= 60% with
 * any "primary" (text-extracted) group — that's the common case
 * where the same list appears both in a CD&A "compensation peer
 * group … was composed of:" sentence and an HTML table.
 */
function mergePeerGroups(
  primary: ExtractedPeerGroup[],
  secondary: ExtractedPeerGroup[],
): ExtractedPeerGroup[] {
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;
  const out = [...primary];
  for (const s of secondary) {
    const sIds = new Set(
      s.members.map((m) => m.company_id_resolved ?? m.company_name_raw),
    );
    let overlapped = false;
    for (const p of primary) {
      const pIds = new Set(
        p.members.map((m) => m.company_id_resolved ?? m.company_name_raw),
      );
      const intersect = [...sIds].filter((id) => pIds.has(id)).length;
      const denom = Math.max(sIds.size, pIds.size);
      if (denom > 0 && intersect / denom >= 0.6) {
        overlapped = true;
        break;
      }
    }
    if (!overlapped) out.push(s);
  }
  return out;
}
import { extractFactsFromSections } from "@/lib/extractors/facts";
import { extractProxySections } from "@/lib/extractors/proxy-sections";

interface IngestOptions {
  limit?: number;
  /**
   * Override the audit row written at the end. Used by the public
   * on-demand path to tag the job as `public_ingest` and attach the
   * hashed client identifier for the rate gate. Defaults to
   * `company_backfill` (admin flow).
   */
  audit?: {
    job_type?: string;
    client_hash?: string;
  };
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

  // 1. Resolve identifier → CIK + company info via the central tickers feed.
  const tickersResp = await sec.fetchJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
    "https://www.sec.gov/files/company_tickers.json",
  );
  const upper = identifier.toUpperCase();
  const tickerEntry =
    Object.values(tickersResp).find((e) => e.ticker.toUpperCase() === upper) ??
    Object.values(tickersResp).find((e) => String(e.cik_str).padStart(10, "0") === upper.padStart(10, "0"));
  if (!tickerEntry) {
    throw new Error(`could not resolve identifier ${identifier}`);
  }
  const cik = String(tickerEntry.cik_str).padStart(10, "0");
  const companyId = tickerEntry.ticker.toLowerCase();

  // 2. Upsert company row.
  await db()
    .insert(schema.companies)
    .values({
      id: companyId,
      cik,
      ticker: tickerEntry.ticker,
      name: tickerEntry.title,
    })
    .onConflictDoUpdate({
      target: schema.companies.id,
      set: { ticker: tickerEntry.ticker, name: tickerEntry.title, updated_at: new Date() },
    });

  // 3. Submissions JSON.
  const subs = await sec.fetchJson<{
    name: string;
    cik: string;
    tickers: string[];
    filings: { recent: { accessionNumber: string[]; form: string[]; filingDate: string[]; primaryDocument: string[] } };
  }>(sec.submissionsUrl(cik));
  const recent = subs.filings.recent;
  const matching: { accession: string; form: string; filingDate: string; primaryDocument: string }[] = [];
  for (let i = 0; i < recent.accessionNumber.length && matching.length < limit; i++) {
    const form = recent.form[i] ?? "";
    if (!TARGET_FORM_TYPES.has(form)) continue;
    matching.push({
      accession: recent.accessionNumber[i] ?? "",
      form,
      filingDate: recent.filingDate[i] ?? "",
      primaryDocument: recent.primaryDocument[i] ?? "",
    });
  }

  // 4. Per filing
  let processed = 0;
  for (const f of matching) {
    try {
      const filingId = f.accession.replace(/-/g, "");
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
      const peers = mergePeerGroups(peersFromText, peersFromHtml);
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

  return { identifier, company_id: companyId, filings_processed: processed, errors };
}
