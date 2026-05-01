/**
 * Policy + metric fact extractor — TS port of
 * /srv/projects/ProxyMiner/apps/api/app/services/fact_extractor.py (1,263 lines).
 *
 * STATUS: scaffold + smallest-viable rules. Full port is in flight.
 *
 * The Python version runs ~30 deterministic rules across:
 *   - policy: clawback, stock_ownership, hedging_pledging, change_in_control,
 *     compensation_consultant
 *   - metric: say_on_pay, annual_incentive_payout, relative_tsr, tsr,
 *     revenue, operating_income, performance_rsu_vesting,
 *     performance_equity_mix, time_equity_mix
 *
 * Per Decisions D-002 (P1-6), the Python version contains
 * company-specific branches at fact_extractor.py:179, 717-761
 * (Microsoft, Salesforce). Those need explicit reimplementation
 * before this extractor can claim parity on those filings.
 *
 * The full pattern catalogue is on disk. Each new rule lands as a
 * function below + a parity test entry in facts.parity.test.ts.
 */
import type { PolicyFactRow, MetricFactRow } from "@/lib/types";

export const FACT_EXTRACTOR_VERSION = "fact_extractor.ts.v1";

const POSITIVE_HINTS = [
  "we have", "the company has", "we maintain", "the company maintains",
  "we adopted", "we require", "must", "shall", "is required",
];
const NEGATIVE_HINTS = ["we do not", "is not required", "no", "shall not", "may not"];

function stamp() {
  return {
    extractor_version: FACT_EXTRACTOR_VERSION,
    source_document_name: null,
    source_document_sha: null,
    verification_status: "machine_extracted" as const,
    review_status: "unreviewed" as const,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
  };
}

// ── Policy rules ─────────────────────────────────────────────────────

function policyExcerpt(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + len + 200);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function detectPolarity(excerpt: string): "yes" | "no" | "unclear" {
  const lower = excerpt.toLowerCase();
  for (const neg of NEGATIVE_HINTS) {
    if (lower.includes(neg)) return "no";
  }
  for (const pos of POSITIVE_HINTS) {
    if (lower.includes(pos)) return "yes";
  }
  return "unclear";
}

function extractPolicyByPattern(
  text: string,
  filingId: string,
  patterns: RegExp[],
  policy_type: string,
  extraction_method: string,
): Omit<PolicyFactRow, "id" | "section_id"> | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const excerpt = policyExcerpt(text, match.index, match[0].length);
    const value = detectPolarity(excerpt);
    return {
      filing_id: filingId,
      policy_type,
      normalized_value: value,
      summary: null,
      source_excerpt: excerpt,
      confidence_score: 0.9,
      extraction_method,
      ...stamp(),
    };
  }
  return null;
}

// ── Metric rules ─────────────────────────────────────────────────────

function extractSayOnPay(
  text: string,
  filingId: string,
): Omit<MetricFactRow, "id" | "section_id"> | null {
  const pattern =
    /(?:(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of votes cast)?(?:\s+(?:in )?favor)?[^.]{0,80}(?:say[- ]on[- ]pay)|(?:say[- ]on[- ]pay)[^.]{0,80}?(\d{1,3}(?:\.\d+)?)\s*%)/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? "";
  const start = match.index;
  const excerpt = text.slice(Math.max(0, start - 40), Math.min(text.length, start + 200));
  return {
    filing_id: filingId,
    metric_name_raw: "say on pay approval",
    metric_name_normalized: "say_on_pay",
    metric_category: "shareholder_vote",
    plan_type: null,
    observed_value: `${value}%`,
    source_excerpt: excerpt.replace(/\s+/g, " ").trim(),
    confidence_score: 0.85,
    extraction_method: "regex-numeric",
    ...stamp(),
  };
}

export function extractFactsFromCda(
  filingId: string,
  cdaText: string,
): {
  policies: Omit<PolicyFactRow, "id" | "section_id">[];
  metrics: Omit<MetricFactRow, "id" | "section_id">[];
} {
  const policies: Omit<PolicyFactRow, "id" | "section_id">[] = [];
  const metrics: Omit<MetricFactRow, "id" | "section_id">[] = [];

  const clawback = extractPolicyByPattern(
    cdaText,
    filingId,
    [/\bclawback\b/i, /recoupment\s+(?:policy|provision)/i],
    "clawback",
    "regex-clawback",
  );
  if (clawback) policies.push(clawback);

  const hedging = extractPolicyByPattern(
    cdaText,
    filingId,
    [/\bhedging\b/i, /\bpledging\b/i],
    "hedging_pledging",
    "regex-hedging",
  );
  if (hedging) policies.push(hedging);

  const ownership = extractPolicyByPattern(
    cdaText,
    filingId,
    [/stock ownership (?:guidelines|requirements)/i, /(?:executive|director) ownership (?:guidelines|requirements)/i],
    "stock_ownership",
    "regex-ownership",
  );
  if (ownership) policies.push(ownership);

  const cic = extractPolicyByPattern(
    cdaText,
    filingId,
    [/\bchange[\s-]in[\s-]control\b/i, /\bdouble[- ]trigger\b/i],
    "change_in_control",
    "regex-cic",
  );
  if (cic) policies.push(cic);

  const consultant = extractPolicyByPattern(
    cdaText,
    filingId,
    [/(?:independent|compensation)\s+consultant\s+(?:was\s+|is\s+)?(?:engaged|retained|advised)/i],
    "compensation_consultant",
    "regex-consultant",
  );
  if (consultant) policies.push(consultant);

  const sayOnPay = extractSayOnPay(cdaText, filingId);
  if (sayOnPay) metrics.push(sayOnPay);

  return { policies, metrics };
}
