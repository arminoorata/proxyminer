"use client";

/**
 * One-click CSV export of the compare grid. Builds a wide-format CSV
 * with one column per company and one row per axis, mirroring the
 * on-screen layout so the file makes sense pasted into a deck or
 * shared with the comp committee.
 */

interface PayMix {
  base: number;
  bonus: number;
  equity: number;
  other: number;
  total: number;
}

interface ColumnPayload {
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
}

function pct(part: number, total: number): string {
  if (total <= 0) return "";
  return `${Math.round((part / total) * 100)}%`;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replaceAll("\"", "\"\"")}"`;
  }
  return s;
}

function buildCsv(columns: ColumnPayload[]): string {
  const headers = ["Axis", ...columns.map((c) => `${c.companyName}${c.ticker ? ` (${c.ticker})` : ""}`)];
  const rows: (string | number | null)[][] = [];

  rows.push(["Filing year", ...columns.map((c) => c.filingYear)]);
  rows.push(["Filing URL", ...columns.map((c) => c.filingUrl)]);
  rows.push([]);
  rows.push(["— Executive pay —", ...columns.map(() => "")]);
  rows.push(["CEO name", ...columns.map((c) => c.ceoName)]);
  rows.push(["CEO total", ...columns.map((c) => c.ceoTotal)]);
  rows.push(["CEO year", ...columns.map((c) => c.ceoYear)]);
  rows.push(["NEOs reported", ...columns.map((c) => c.neoCount)]);
  rows.push([
    "CEO base %",
    ...columns.map((c) => (c.payMix ? pct(c.payMix.base, c.payMix.total) : "")),
  ]);
  rows.push([
    "CEO cash incentive %",
    ...columns.map((c) => (c.payMix ? pct(c.payMix.bonus, c.payMix.total) : "")),
  ]);
  rows.push([
    "CEO equity %",
    ...columns.map((c) => (c.payMix ? pct(c.payMix.equity, c.payMix.total) : "")),
  ]);
  rows.push([
    "CEO other %",
    ...columns.map((c) => (c.payMix ? pct(c.payMix.other, c.payMix.total) : "")),
  ]);
  rows.push([
    "CEO at-risk %",
    ...columns.map((c) =>
      c.payMix ? pct(c.payMix.bonus + c.payMix.equity, c.payMix.total) : "",
    ),
  ]);

  rows.push([]);
  rows.push(["— Peer disclosure —", ...columns.map(() => "")]);
  rows.push(["Primary peer count", ...columns.map((c) => c.primaryPeers)]);

  rows.push([]);
  rows.push(["— Pay ratio (Item 402(u)) —", ...columns.map(() => "")]);
  rows.push(["CEO pay ratio", ...columns.map((c) => c.metrics.ceoPayRatio)]);
  rows.push(["Median employee compensation", ...columns.map((c) => c.metrics.medianEmployeeComp)]);

  rows.push([]);
  rows.push(["— Performance metrics —", ...columns.map(() => "")]);
  rows.push(["Say on pay", ...columns.map((c) => c.metrics.sayOnPay)]);
  rows.push(["Relative TSR", ...columns.map((c) => c.metrics.relativeTsr)]);
  rows.push(["Revenue", ...columns.map((c) => c.metrics.revenue)]);
  rows.push(["Operating income", ...columns.map((c) => c.metrics.operatingIncome)]);
  rows.push(["Annual incentive payout", ...columns.map((c) => c.metrics.annualIncentive)]);
  rows.push(["Performance RSU vesting", ...columns.map((c) => c.metrics.rsuVesting)]);
  rows.push(["LTI mix · performance", ...columns.map((c) => c.metrics.performanceMix)]);
  rows.push(["LTI mix · time", ...columns.map((c) => c.metrics.timeMix)]);

  rows.push([]);
  rows.push(["— Governance —", ...columns.map(() => "")]);
  rows.push(["Hedging policy", ...columns.map((c) => c.policies.hedging)]);
  rows.push(["Pledging policy", ...columns.map((c) => c.policies.pledging)]);
  rows.push(["Clawback", ...columns.map((c) => c.policies.clawback)]);
  rows.push(["Stock ownership guidelines", ...columns.map((c) => c.policies.stockOwnership)]);
  rows.push(["Change in control", ...columns.map((c) => c.policies.changeInControl)]);
  rows.push(["Compensation consultant", ...columns.map((c) => c.policies.compConsultant)]);
  rows.push(["Compensation committee", ...columns.map((c) => c.policies.compCommittee)]);

  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    if (r.length === 0) {
      lines.push("");
      continue;
    }
    lines.push(r.map(csvCell).join(","));
  }
  return lines.join("\n");
}

export default function CompareCsvButton({ columns }: { columns: ColumnPayload[] }) {
  function download() {
    const csv = buildCsv(columns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `proxyminer-compare-${columns
      .map((c) => c.companyId)
      .join("-")}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-md border px-3 py-1.5 text-[12px] uppercase tracking-[0.16em] hover:border-accent"
      style={{ borderColor: "var(--line)", color: "var(--text)" }}
    >
      Export CSV
    </button>
  );
}
