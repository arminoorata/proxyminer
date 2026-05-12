/**
 * Section-level re-extraction. For each filing already in Postgres,
 * fetch the cached primary-document HTML from Vercel Blob, re-run the
 * full section extractor suite (CD&A + pay-ratio + say-on-pay +
 * compensation committee report), and replace any sections/facts whose
 * extractor has changed.
 *
 *   curl -X POST https://proxyminer.arminoorata.com/api/admin/reextract-sections \
 *     -H "Authorization: Bearer $PROXYMINER_ADMIN_API_TOKEN"
 *
 * Idempotent: each filing's sections are replaced wholesale (same
 * replace-then-insert semantics ingestion uses). Facts are appended
 * only for (filing_id, policy_type) / (filing_id, metric_name_normalized)
 * tuples that don't already exist, so re-runs don't duplicate facts
 * that were already extracted from CD&A — but a re-run WILL surface
 * facts that the dedicated pay-ratio / committee section now provides.
 *
 * Why split this from /api/admin/reextract-facts:
 *   - reextract-facts only re-runs the fact extractor against the
 *     CD&A text already in pg. It does not change which sections exist.
 *   - reextract-sections re-runs section discovery itself, which can
 *     INSERT new section rows (`section_type = "ceo_pay_ratio"` etc.).
 *
 * Cost note: this hits Blob once per filing to refetch HTML; for ~40
 * filings that's fine, but if the cohort grows past a couple hundred
 * filings the route should be paginated or moved to a cron task.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { getArtifactBytes } from "@/lib/blob/client";
import { db, schema } from "@/lib/db/client";
import { extractCdAndA } from "@/lib/extractors/cd-and-a";
import {
  extractProxySections,
  PAY_RATIO_EXTRACTOR_VERSION,
  SAY_ON_PAY_EXTRACTOR_VERSION,
  COMP_COMMITTEE_REPORT_EXTRACTOR_VERSION,
} from "@/lib/extractors/proxy-sections";
import { extractFactsFromSections } from "@/lib/extractors/facts";

const PROXY_SECTION_TYPES = [
  "cd_and_a",
  "ceo_pay_ratio",
  "say_on_pay",
  "compensation_committee_report",
] as const;

export const runtime = "nodejs";
export const maxDuration = 60;

interface ReextractCounts {
  filings_total: number;
  filings_scanned: number;
  filings_missing_blob: number;
  sections_replaced: number;
  proxy_sections_added: number;
  policies_added: number;
  metrics_added: number;
  next_offset: number | null;
}

export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "DATABASE_URL not set" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  // Chunked invocation. The Hobby 60s function cap can't reprocess
  // ~50 filings in one call; the operator (or a cron orchestrator)
  // walks the corpus by passing `?offset=N&limit=M`. `next_offset` in
  // the response tells the caller where to pick up. Defaults pick up
  // a reasonable batch on a manual unparam'd call.
  const url = new URL(req.url);
  const offsetRaw = url.searchParams.get("offset");
  const limitRaw = url.searchParams.get("limit");
  const offset = Math.max(0, Number.parseInt(offsetRaw ?? "0", 10) || 0);
  const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? "20", 10) || 20));

  const counts: ReextractCounts = {
    filings_total: 0,
    filings_scanned: 0,
    filings_missing_blob: 0,
    sections_replaced: 0,
    proxy_sections_added: 0,
    policies_added: 0,
    metrics_added: 0,
    next_offset: null,
  };

  try {
    const conn = db();
    const allFilings = await conn
      .select()
      .from(schema.filings)
      .orderBy(schema.filings.id);
    counts.filings_total = allFilings.length;
    const filings = allFilings.slice(offset, offset + limit);
    counts.next_offset = offset + filings.length < allFilings.length
      ? offset + filings.length
      : null;

    for (const filing of filings) {
      counts.filings_scanned++;

      const docName = filing.primary_document_name;
      if (!docName) {
        counts.filings_missing_blob++;
        continue;
      }
      const key = `${filing.company_id}/${filing.id}/${docName}`;
      let bytes: Buffer | null;
      try {
        bytes = await getArtifactBytes(key);
      } catch (err) {
        // Vercel Blob throws when head() can't resolve the key. Treat
        // "missing" the same as null so one stale filing pointer doesn't
        // abort the whole batch — the operator can re-ingest separately.
        const msg = err instanceof Error ? err.message : String(err);
        if (/blob does not exist|not found/i.test(msg)) {
          counts.filings_missing_blob++;
          continue;
        }
        throw err;
      }
      if (!bytes) {
        counts.filings_missing_blob++;
        continue;
      }
      const html = bytes.toString("utf8");

      const cda = extractCdAndA(html);
      const proxySections = extractProxySections(html);

      // Snapshot review metadata for the section types we're about to
      // replace, then carry it forward into the new rows. Without this
      // a re-extract would silently reset any human-reviewed
      // verification/review fields back to "machine_extracted /
      // unreviewed", erasing reviewer judgment.
      const existing = await conn
        .select()
        .from(schema.sections)
        .where(
          and(
            eq(schema.sections.filing_id, filing.id),
            inArray(schema.sections.section_type, [...PROXY_SECTION_TYPES]),
          ),
        );
      const reviewByType = new Map<
        string,
        {
          text: string;
          verification_status: typeof schema.sections.$inferInsert.verification_status;
          review_status: typeof schema.sections.$inferInsert.review_status;
          reviewed_by: typeof schema.sections.$inferInsert.reviewed_by;
          reviewed_at: typeof schema.sections.$inferInsert.reviewed_at;
          review_notes: typeof schema.sections.$inferInsert.review_notes;
        }
      >();
      for (const row of existing) {
        reviewByType.set(row.section_type, {
          text: row.text ?? "",
          verification_status: row.verification_status,
          review_status: row.review_status,
          reviewed_by: row.reviewed_by,
          reviewed_at: row.reviewed_at,
          review_notes: row.review_notes,
        });
      }

      // Scope the delete to ONLY the section types we know how to
      // re-produce. Section types written by other extractors stay
      // intact, and "unreviewed/machine_extracted" defaults below are
      // overridden by withReview() when both:
      //   (a) the row existed before, and
      //   (b) the extracted text is byte-identical to the prior text.
      // If text changed, reset to defaults so a reviewer is forced to
      // re-verify — otherwise a downstream extractor update could
      // silently "carry" a verification onto unseen new text (P2).
      await conn
        .delete(schema.sections)
        .where(
          and(
            eq(schema.sections.filing_id, filing.id),
            inArray(schema.sections.section_type, [...PROXY_SECTION_TYPES]),
          ),
        );

      function withReview<T extends { text: string }>(
        sectionType: string,
        base: T,
      ): T {
        const carry = reviewByType.get(sectionType);
        if (!carry) return base;
        // Text changed — reset review state so the reviewer sees the
        // new content. Only the audit history of who-last-reviewed is
        // lost; the actual review records are immutable.
        if (carry.text !== base.text) return base;
        const { text: _drop, ...rest } = carry;
        void _drop;
        return { ...base, ...rest };
      }

      if (cda) {
        await conn.insert(schema.sections).values(
          withReview("cd_and_a", {
            filing_id: filing.id,
            section_type: "cd_and_a",
            heading: cda.heading,
            normalized_heading: cda.heading.toLowerCase(),
            text: cda.text,
            html_fragment: cda.html_fragment,
            confidence_score: cda.confidence_score.toFixed(3) as unknown as string,
            extractor_version: "cda_extractor.ts.v1",
            extraction_method: cda.method,
            source_document_name: docName,
            source_document_sha: null,
          }),
        );
        counts.sections_replaced++;
      }

      for (const s of proxySections) {
        const versionByType: Record<string, string> = {
          ceo_pay_ratio: PAY_RATIO_EXTRACTOR_VERSION,
          say_on_pay: SAY_ON_PAY_EXTRACTOR_VERSION,
          compensation_committee_report: COMP_COMMITTEE_REPORT_EXTRACTOR_VERSION,
        };
        await conn.insert(schema.sections).values(
          withReview(s.section_type, {
            filing_id: filing.id,
            section_type: s.section_type,
            heading: s.section.heading,
            normalized_heading: s.section.heading.toLowerCase(),
            text: s.section.text,
            html_fragment: s.section.html_fragment,
            confidence_score: s.section.confidence_score.toFixed(3) as unknown as string,
            extractor_version: versionByType[s.section_type] ?? s.extractor_version,
            extraction_method: s.section.method,
            source_document_name: docName,
            source_document_sha: null,
          }),
        );
        counts.proxy_sections_added++;
      }

      // Re-run facts now that we have additional sections. For
      // facts the filing already has:
      //   - if it's REVIEWED (human approved/rejected), leave it
      //     alone — the reviewer's decision wins.
      //   - if it's still UNREVIEWED and the extractor now produces
      //     a different (or non-null) value, UPDATE the row so stale
      //     null values get refreshed (e.g. AYI's pay-ratio rule
      //     improved post-ingest).
      // Truly new facts (no prior row) are INSERTed with default
      // review state (machine_extracted / unreviewed).
      const sectionInputs: { section_type: string; text: string; heading?: string | null }[] = [];
      if (cda) sectionInputs.push({ section_type: "cd_and_a", text: cda.text, heading: cda.heading });
      for (const s of proxySections) {
        sectionInputs.push({
          section_type: s.section_type,
          text: s.section.text,
          heading: s.section.heading,
        });
      }
      const result = extractFactsFromSections(filing.id, sectionInputs);

      const existingPolicyRows = await conn
        .select()
        .from(schema.policy_facts)
        .where(eq(schema.policy_facts.filing_id, filing.id));
      const policyByType = new Map(
        existingPolicyRows.map((r) => [r.policy_type, r] as const),
      );

      const existingMetricRows = await conn
        .select()
        .from(schema.metric_facts)
        .where(eq(schema.metric_facts.filing_id, filing.id));
      const metricByName = new Map(
        existingMetricRows
          .filter((r) => r.metric_name_normalized != null)
          .map((r) => [r.metric_name_normalized as string, r] as const),
      );

      const newPolicies: typeof result.policies = [];
      for (const p of result.policies) {
        const existing = policyByType.get(p.policy_type);
        if (!existing) {
          newPolicies.push(p);
          continue;
        }
        if (existing.review_status !== "unreviewed") continue;
        // Existing is unreviewed; replace if the new extractor has a
        // different value (or fills in a previously-null one).
        if (existing.normalized_value !== p.normalized_value) {
          await conn
            .update(schema.policy_facts)
            .set({
              normalized_value: p.normalized_value,
              summary: p.summary,
              source_excerpt: p.source_excerpt,
              confidence_score:
                p.confidence_score == null ? null : String(p.confidence_score),
              extractor_version: p.extractor_version,
              extraction_method: p.extraction_method,
            })
            .where(eq(schema.policy_facts.id, existing.id));
          counts.policies_added++;
        }
      }
      const newMetrics: typeof result.metrics = [];
      for (const m of result.metrics) {
        const name = m.metric_name_normalized;
        if (name === null) continue;
        const existing = metricByName.get(name);
        if (!existing) {
          newMetrics.push(m);
          continue;
        }
        if (existing.review_status !== "unreviewed") continue;
        if (existing.observed_value !== m.observed_value) {
          await conn
            .update(schema.metric_facts)
            .set({
              observed_value: m.observed_value,
              source_excerpt: m.source_excerpt,
              confidence_score:
                m.confidence_score == null ? null : String(m.confidence_score),
              extractor_version: m.extractor_version,
              extraction_method: m.extraction_method,
            })
            .where(eq(schema.metric_facts.id, existing.id));
          counts.metrics_added++;
        }
      }

      if (newPolicies.length > 0) {
        await conn.insert(schema.policy_facts).values(
          newPolicies.map((p) => ({
            filing_id: filing.id,
            policy_type: p.policy_type,
            normalized_value: p.normalized_value,
            summary: p.summary,
            source_excerpt: p.source_excerpt,
            confidence_score: p.confidence_score == null ? null : String(p.confidence_score),
            extractor_version: p.extractor_version,
            extraction_method: p.extraction_method,
          })),
        );
        counts.policies_added += newPolicies.length;
      }
      if (newMetrics.length > 0) {
        await conn.insert(schema.metric_facts).values(
          newMetrics.map((m) => ({
            filing_id: filing.id,
            metric_name_raw: m.metric_name_raw,
            metric_name_normalized: m.metric_name_normalized,
            metric_category: m.metric_category,
            plan_type: m.plan_type,
            observed_value: m.observed_value,
            source_excerpt: m.source_excerpt,
            confidence_score: m.confidence_score == null ? null : String(m.confidence_score),
            extractor_version: m.extractor_version,
            extraction_method: m.extraction_method,
          })),
        );
        counts.metrics_added += newMetrics.length;
      }
    }

    return NextResponse.json({ ok: true, counts }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), counts },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
