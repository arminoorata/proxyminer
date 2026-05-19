/**
 * Shared helpers that turn (company + filing) data into a flat
 * `ColumnPayload` suited for CSV emission. Used by:
 *   - CompareCsvButton (client; the compare page passes pre-built
 *     payloads in)
 *   - /api/peerset/export (server; needs to build payloads from
 *     company IDs without the rest of the compare page mounted)
 *
 * Splitting this out lets both surfaces guarantee column parity.
 */
import { isCeoPosition } from "@/lib/exec/ceo";
import { cleanExecutiveDisplayName } from "@/lib/exec/display";
import type { CompanyRow, FilingDetail } from "@/lib/types";

export interface PayMix {
  base: number;
  bonus: number;
  equity: number;
  other: number;
  total: number;
}

export interface ColumnPayload {
  companyId: string;
  companyName: string;
  ticker: string | null;
  filingYear: number | null;
  filingUrl: string | null;
  ceoName: string | null;
  ceoTotal: number | null;
  ceoYear: number | null;
  neoCount: number;
  primaryPeers: number;
  policies: {
    hedging: string;
    pledging: string;
    clawback: string;
    stockOwnership: string;
    changeInControl: string;
    compConsultant: string;
    compCommittee: string;
  };
  metrics: {
    sayOnPay: string;
    relativeTsr: string;
    revenue: string;
    operatingIncome: string;
    annualIncentive: string;
    rsuVesting: string;
    performanceMix: string;
    timeMix: string;
    ceoPayRatio: string;
    medianEmployeeComp: string;
  };
  payMix: PayMix | null;
  /** Marker used by the CSV header so analysts can tell which rows
   *  weren't ingested (the request was honored but the company isn't
   *  in our DB). Always false on server-built payloads except where
   *  getCompany() returned null. */
  notIngested: boolean;
}

function magnitude(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(String(v).replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : null;
}

function ceoTotal(
  filing: FilingDetail | null,
): { exec: string; total: number; year: number } | null {
  if (!filing) return null;
  const years = filing.executive_compensation.map((r) => r.year);
  if (years.length === 0) return null;
  const latestYear = Math.max(...years);
  const ceo = filing.executive_compensation.find(
    (r) => r.year === latestYear && isCeoPosition(r.principal_position),
  );
  if (!ceo) return null;
  return {
    exec: cleanExecutiveDisplayName(ceo.executive_name),
    total: magnitude(ceo.total) ?? 0,
    year: ceo.year,
  };
}

function ceoPayMix(filing: FilingDetail | null): PayMix | null {
  if (!filing) return null;
  const years = filing.executive_compensation.map((r) => r.year);
  if (years.length === 0) return null;
  const latestYear = Math.max(...years);
  const ceo = filing.executive_compensation.find(
    (r) => r.year === latestYear && isCeoPosition(r.principal_position),
  );
  if (!ceo) return null;
  const base = magnitude(ceo.salary) ?? 0;
  const bonus =
    (magnitude(ceo.bonus) ?? 0) +
    (magnitude(ceo.non_equity_incentive_plan_compensation) ?? 0);
  const equity =
    (magnitude(ceo.stock_awards) ?? 0) + (magnitude(ceo.option_awards) ?? 0);
  const other = magnitude(ceo.all_other_compensation) ?? 0;
  const total = base + bonus + equity + other;
  if (total <= 0) return null;
  return { base, bonus, equity, other, total };
}

function neoCount(filing: FilingDetail | null): number {
  if (!filing) return 0;
  const years = filing.executive_compensation.map((r) => r.year);
  if (years.length === 0) return 0;
  const latestYear = Math.max(...years);
  return filing.executive_compensation.filter((r) => r.year === latestYear)
    .length;
}

function primaryPeerCount(filing: FilingDetail | null): number {
  if (!filing) return 0;
  const primary =
    filing.peer_groups.find((g) => g.peer_group_type === "primary") ??
    filing.peer_groups[0];
  return primary?.members.length ?? 0;
}

function findPolicy(filing: FilingDetail | null, type: string): string {
  if (!filing) return "—";
  const p = filing.policies.find((x) => x.policy_type === type);
  if (!p) return "Not extracted";
  return p.normalized_value ?? p.summary ?? "Disclosed";
}

function findMetric(filing: FilingDetail | null, normalized: string): string {
  if (!filing) return "—";
  const m = filing.metrics.find((x) => x.metric_name_normalized === normalized);
  if (!m) return "Not extracted";
  return m.observed_value ?? "Disclosed";
}

export function buildColumnPayload(
  company: CompanyRow,
  filing: FilingDetail | null,
): ColumnPayload {
  return {
    companyId: company.id,
    companyName: company.name,
    ticker: company.ticker,
    filingYear: filing?.filing_year ?? null,
    filingUrl: filing?.primary_document_url ?? null,
    ceoName: ceoTotal(filing)?.exec ?? null,
    ceoTotal: ceoTotal(filing)?.total ?? null,
    ceoYear: ceoTotal(filing)?.year ?? null,
    neoCount: neoCount(filing),
    primaryPeers: primaryPeerCount(filing),
    policies: {
      hedging: findPolicy(filing, "hedging"),
      pledging: findPolicy(filing, "pledging"),
      clawback: findPolicy(filing, "clawback"),
      stockOwnership: findPolicy(filing, "stock_ownership_guidelines"),
      changeInControl: findPolicy(filing, "change_in_control"),
      compConsultant: findPolicy(filing, "compensation_consultant"),
      compCommittee: findPolicy(filing, "compensation_committee"),
    },
    metrics: {
      sayOnPay: findMetric(filing, "say_on_pay"),
      relativeTsr: findMetric(filing, "relative_tsr"),
      revenue: findMetric(filing, "revenue"),
      operatingIncome: findMetric(filing, "operating_income"),
      annualIncentive: findMetric(filing, "annual_incentive_payout"),
      rsuVesting: findMetric(filing, "performance_rsu_vesting"),
      performanceMix: findMetric(filing, "performance_equity_mix"),
      timeMix: findMetric(filing, "time_equity_mix"),
      ceoPayRatio: findMetric(filing, "ceo_pay_ratio"),
      medianEmployeeComp: findMetric(filing, "median_employee_compensation"),
    },
    payMix: ceoPayMix(filing),
    notIngested: false,
  };
}

export function notIngestedPayload(id: string): ColumnPayload {
  const upper = id.toUpperCase();
  return {
    companyId: id,
    companyName: upper,
    ticker: upper,
    filingYear: null,
    filingUrl: null,
    ceoName: null,
    ceoTotal: null,
    ceoYear: null,
    neoCount: 0,
    primaryPeers: 0,
    policies: {
      hedging: "—",
      pledging: "—",
      clawback: "—",
      stockOwnership: "—",
      changeInControl: "—",
      compConsultant: "—",
      compCommittee: "—",
    },
    metrics: {
      sayOnPay: "—",
      relativeTsr: "—",
      revenue: "—",
      operatingIncome: "—",
      annualIncentive: "—",
      rsuVesting: "—",
      performanceMix: "—",
      timeMix: "—",
      ceoPayRatio: "—",
      medianEmployeeComp: "—",
    },
    payMix: null,
    notIngested: true,
  };
}
