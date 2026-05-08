/**
 * One-shot re-extraction route. For every filing already in Postgres,
 * read the CD&A section text, run the TypeScript fact extractor (with
 * the new ceo_pay_ratio + median_employee_compensation + compensation_committee
 * patterns), and append any policy_facts / metric_facts that don't
 * already exist for that filing.
 *
 *   curl -X POST https://proxyminer.arminoorata.com/api/admin/reextract-facts \
 *     -H "Authorization: Bearer $PROXYMINER_ADMIN_API_TOKEN"
 *
 * Idempotent. Only inserts rows whose (filing_id, policy_type) or
 * (filing_id, metric_name_normalized) tuple isn't already present, so
 * running it repeatedly won't duplicate. Existing extractor versions
 * for the unchanged facts are left untouched.
 */
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { db, schema } from "@/lib/db/client";
import { extractFactsFromCda } from "@/lib/extractors/facts";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ReextractCounts {
  filings_scanned: number;
  policies_added: number;
  metrics_added: number;
  filings_skipped_no_cda: number;
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
    policies_added: 0,
    metrics_added: 0,
    filings_skipped_no_cda: 0,
  };

  try {
    const conn = db();
    const filings = await conn.select().from(schema.filings);

    for (const filing of filings) {
      counts.filings_scanned++;

      const sections = await conn
        .select()
        .from(schema.sections)
        .where(eq(schema.sections.filing_id, filing.id));
      const cda = sections.find((s) => s.section_type === "cd_and_a");
      if (!cda || !cda.text) {
        counts.filings_skipped_no_cda++;
        continue;
      }

      const result = extractFactsFromCda(filing.id, cda.text);

      // Skip policy/metric types that already exist for this filing.
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
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
