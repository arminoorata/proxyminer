/**
 * Builds the grounded context that the assistant sees. Strict scope:
 * one company, one filing (the latest unless a specific one was asked
 * about), optionally a previous filing for YoY context, optionally a
 * compare result if the user is on the benchmark view.
 *
 * Plan §"Non-Negotiable Principles #2" + §"AI topology": context is
 * assembled server-side, the model never sees raw HTML, and every
 * value the model is told it can cite is a deterministic-extracted
 * row.
 */
import type { Citation } from "./citation-schema";
import type { FilingDetail, CompanyRow, ExecutiveCompRow } from "@/lib/types";

export interface AskContext {
  company: CompanyRow;
  filing: FilingDetail;
  prior_filing: FilingDetail | null;
  /** A tiny structured snapshot the model is allowed to read. */
  fact_pack: ContextFactPack;
}

export interface ContextFactPack {
  company: { id: string; name: string; ticker: string | null };
  filing: { id: string; year: number; date: string; form_type: string };
  prior_filing: { id: string; year: number } | null;
  // Bounded to a handful of CD&A excerpts (top-of-section + each
  // subheading) so the prompt stays well under model context limits
  // and there's no incentive to summarize across the full filing.
  cd_and_a_excerpts: { section_type: string; excerpt: string }[];
  executive_comp: ExecutiveCompMini[];
  policies: { policy_type: string; normalized_value: string | null; summary: string | null }[];
  metrics: {
    metric_name_normalized: string;
    observed_value: string | null;
    plan_type: string | null;
  }[];
  peer_groups: { name: string | null; member_count: number; sample: string[] }[];
}

export interface ExecutiveCompMini {
  executive_name: string;
  principal_position: string | null;
  year: number;
  total: string | null;
  pay_mix?: { base_pct: number; cash_pct: number; equity_pct: number; other_pct: number; at_risk_pct: number } | null;
  yoy_total_pct?: number | null;
}

const CDA_EXCERPT_LEN = 600;
const PEER_SAMPLE = 6;

export function buildContext(
  company: CompanyRow,
  filing: FilingDetail,
  prior_filing: FilingDetail | null,
): AskContext {
  return {
    company,
    filing,
    prior_filing,
    fact_pack: assemblePack(company, filing, prior_filing),
  };
}

function assemblePack(
  company: CompanyRow,
  filing: FilingDetail,
  prior: FilingDetail | null,
): ContextFactPack {
  return {
    company: { id: company.id, name: company.name, ticker: company.ticker },
    filing: {
      id: filing.id,
      year: filing.filing_year,
      date: String(filing.filing_date ?? ""),
      form_type: filing.form_type,
    },
    prior_filing: prior
      ? { id: prior.id, year: prior.filing_year }
      : null,
    cd_and_a_excerpts: filing.sections
      .filter((s) => s.section_type === "cd_and_a")
      .map((s) => ({
        section_type: s.section_type,
        excerpt: (s.text ?? "").slice(0, CDA_EXCERPT_LEN),
      })),
    executive_comp: deriveExecMini(filing.executive_compensation, prior?.executive_compensation ?? []),
    policies: filing.policies.map((p) => ({
      policy_type: p.policy_type,
      normalized_value: p.normalized_value,
      summary: p.summary,
    })),
    metrics: filing.metrics.map((m) => ({
      metric_name_normalized: m.metric_name_normalized ?? m.metric_name_raw,
      observed_value: m.observed_value,
      plan_type: m.plan_type,
    })),
    peer_groups: filing.peer_groups.map((g) => ({
      name: g.peer_group_name,
      member_count: g.members.length,
      sample: g.members
        .slice(0, PEER_SAMPLE)
        .map(
          (m) =>
            m.company_name_resolved ?? m.company_name_raw,
        ),
    })),
  };
}

function deriveExecMini(
  current: ExecutiveCompRow[],
  prior: ExecutiveCompRow[],
): ExecutiveCompMini[] {
  const priorByName = new Map<string, ExecutiveCompRow>(
    prior.map((r) => [r.executive_name.trim().toLowerCase(), r]),
  );
  return current.map((row) => {
    const priorRow = priorByName.get(row.executive_name.trim().toLowerCase());
    return {
      executive_name: row.executive_name,
      principal_position: row.principal_position,
      year: row.year,
      total: row.total,
      pay_mix: payMix(row),
      yoy_total_pct: yoy(row.total, priorRow?.total),
    };
  });
}

function magnitude(v: string | null): number | null {
  if (!v) return null;
  const n = Number(String(v).replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : null;
}

function payMix(r: ExecutiveCompRow): ExecutiveCompMini["pay_mix"] {
  const base = magnitude(r.salary) ?? 0;
  const bonus = (magnitude(r.bonus) ?? 0) + (magnitude(r.non_equity_incentive_plan_compensation) ?? 0);
  const equity = (magnitude(r.stock_awards) ?? 0) + (magnitude(r.option_awards) ?? 0);
  const other = magnitude(r.all_other_compensation) ?? 0;
  const sum = base + bonus + equity + other;
  if (sum <= 0) return null;
  return {
    base_pct: Math.round((base / sum) * 100),
    cash_pct: Math.round((bonus / sum) * 100),
    equity_pct: Math.round((equity / sum) * 100),
    other_pct: Math.round((other / sum) * 100),
    at_risk_pct: Math.round(((bonus + equity) / sum) * 100),
  };
}

function yoy(current: string | null, prior: string | null | undefined): number | null {
  const a = magnitude(current);
  const b = magnitude(prior ?? null);
  if (a == null || b == null || b === 0) return null;
  return Math.round(((a - b) / b) * 100);
}

/**
 * Validate that every citation the model returned points at an
 * artifact actually present in the assembled context. Citations that
 * don't resolve are dropped — the route handler can then decide
 * whether to retry, refuse, or return the answer with a scope_note.
 */
export function validateCitations(
  citations: Citation[],
  ctx: AskContext,
): { valid: Citation[]; rejected: Citation[] } {
  const valid: Citation[] = [];
  const rejected: Citation[] = [];

  for (const c of citations) {
    if (c.filing_id !== ctx.filing.id && c.filing_id !== ctx.prior_filing?.id) {
      rejected.push(c);
      continue;
    }
    if (resolveCitation(c, ctx) == null) {
      rejected.push(c);
      continue;
    }
    valid.push(c);
  }
  return { valid, rejected };
}

function resolveCitation(c: Citation, ctx: AskContext): unknown {
  const filing =
    c.filing_id === ctx.filing.id ? ctx.filing : ctx.prior_filing ?? ctx.filing;
  const ref = c.ref;
  // Switching on the discriminator inside the union narrows each case
  // to the corresponding variant — TS infers the right ref shape per
  // branch this way.
  switch (ref.kind) {
    case "executive_comp":
      return filing.executive_compensation.find(
        (r) =>
          r.executive_name.trim().toLowerCase() ===
            ref.executive_name.trim().toLowerCase() && r.year === ref.year,
      );
    case "policy_fact":
      return filing.policies.find((p) => p.policy_type === ref.policy_type);
    case "metric_fact":
      return filing.metrics.find(
        (m) =>
          (m.metric_name_normalized ?? m.metric_name_raw) ===
          ref.metric_name_normalized,
      );
    case "peer_group":
      return filing.peer_groups[0];
    case "peer_member":
      return filing.peer_groups
        .flatMap((g) => g.members)
        .find(
          (m) =>
            m.company_name_raw.trim().toLowerCase() ===
            ref.company_name_raw.trim().toLowerCase(),
        );
    case "section_excerpt":
      return filing.sections.find((s) => s.section_type === ref.section_type);
    case "filing_metadata":
      return filing[ref.field as keyof FilingDetail] as unknown;
    default: {
      const _exhaustive: never = ref;
      void _exhaustive;
      return null;
    }
  }
}
