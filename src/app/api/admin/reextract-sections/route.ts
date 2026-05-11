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
  filings_scanned: number;
  filings_missing_blob: number;
  sections_replaced: number;
  proxy_sections_added: number;
  policies_added: number;
  metrics_added: number;
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

  const counts: ReextractCounts = {
    filings_scanned: 0,
    filings_missing_blob: 0,
    sections_replaced: 0,
    proxy_sections_added: 0,
    policies_added: 0,
    metrics_added: 0,
  };

  try {
    const conn = db();
    const filings = await conn.select().from(schema.filings);

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
          verification_status: typeof schema.sections.$inferInsert.verification_status;
          review_status: typeof schema.sections.$inferInsert.review_status;
          reviewed_by: typeof schema.sections.$inferInsert.reviewed_by;
          reviewed_at: typeof schema.sections.$inferInsert.reviewed_at;
          review_notes: typeof schema.sections.$inferInsert.review_notes;
        }
      >();
      for (const row of existing) {
        reviewByType.set(row.section_type, {
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
      // overridden by the snapshot when the row has been reviewed.
      await conn
        .delete(schema.sections)
        .where(
          and(
            eq(schema.sections.filing_id, filing.id),
            inArray(schema.sections.section_type, [...PROXY_SECTION_TYPES]),
          ),
        );

      function withReview<T extends Record<string, unknown>>(
        sectionType: string,
        base: T,
      ) {
        const carry = reviewByType.get(sectionType);
        return carry ? { ...base, ...carry } : base;
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

      // Re-run facts now that we have additional sections. Only insert
      // facts for (filing_id, policy_type/metric_name) pairs that
      // don't already exist; we don't want to duplicate or clobber
      // values produced by a prior CD&A-only extraction.
      const sectionInputs: { section_type: string; text: string }[] = [];
      if (cda) sectionInputs.push({ section_type: "cd_and_a", text: cda.text });
      for (const s of proxySections) {
        sectionInputs.push({ section_type: s.section_type, text: s.section.text });
      }
      const result = extractFactsFromSections(filing.id, sectionInputs);

      const existingPolicies = await conn
        .select({ policy_type: schema.policy_facts.policy_type })
        .from(schema.policy_facts)
        .where(eq(schema.policy_facts.filing_id, filing.id));
      const existingPolicyTypes = new Set(existingPolicies.map((p) => p.policy_type));

      const existingMetrics = await conn
        .select({ name: schema.metric_facts.metric_name_normalized })
        .from(schema.metric_facts)
        .where(eq(schema.metric_facts.filing_id, filing.id));
      const existingMetricNames = new Set(
        existingMetrics.map((m) => m.name).filter((n): n is string => Boolean(n)),
      );

      const newPolicies = result.policies.filter(
        (p) => !existingPolicyTypes.has(p.policy_type),
      );
      const newMetrics = result.metrics.filter((m) => {
        const name = m.metric_name_normalized;
        return name !== null && !existingMetricNames.has(name);
      });

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
