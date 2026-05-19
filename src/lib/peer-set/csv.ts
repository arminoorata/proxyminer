/**
 * CSV builder shared by:
 *   - CompareCsvButton (client; the compare page hands it a
 *     pre-built array of ColumnPayload)
 *   - /api/peerset/export (server; builds payloads from the analyst's
 *     selected company IDs and streams the same CSV shape back)
 *
 * Pure: no fetch, no DOM. Take ColumnPayload[] in, get a string out.
 */
import type { ColumnPayload, PayMix } from "./csv-payload";

function pct(part: number, total: number): string {
  if (total <= 0) return "";
  return `${Math.round((part / total) * 100)}%`;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function payMixCell(mix: PayMix | null, key: "base" | "bonus" | "equity" | "other"): string {
  return mix ? pct(mix[key], mix.total) : "";
}

function atRiskCell(mix: PayMix | null): string {
  return mix ? pct(mix.bonus + mix.equity, mix.total) : "";
}

export function buildPeerSetCsv(columns: ColumnPayload[]): string {
  const headers = [
    "Axis",
    ...columns.map(
      (c) => `${c.companyName}${c.ticker ? ` (${c.ticker})` : ""}`,
    ),
  ];
  const rows: (string | number | null)[][] = [];

  rows.push(["Filing year", ...columns.map((c) => c.filingYear)]);
  rows.push(["Filing URL", ...columns.map((c) => c.filingUrl)]);
  rows.push(["In ProxyMiner DB", ...columns.map((c) => (c.notIngested ? "no" : "yes"))]);
  rows.push([]);
  rows.push(["— Executive pay —", ...columns.map(() => "")]);
  rows.push(["CEO name", ...columns.map((c) => c.ceoName)]);
  rows.push(["CEO total", ...columns.map((c) => c.ceoTotal)]);
  rows.push(["CEO year", ...columns.map((c) => c.ceoYear)]);
  rows.push(["NEOs reported", ...columns.map((c) => c.neoCount)]);
  rows.push(["CEO base %", ...columns.map((c) => payMixCell(c.payMix, "base"))]);
  rows.push([
    "CEO cash incentive %",
    ...columns.map((c) => payMixCell(c.payMix, "bonus")),
  ]);
  rows.push(["CEO equity %", ...columns.map((c) => payMixCell(c.payMix, "equity"))]);
  rows.push(["CEO other %", ...columns.map((c) => payMixCell(c.payMix, "other"))]);
  rows.push(["CEO at-risk %", ...columns.map((c) => atRiskCell(c.payMix))]);

  rows.push([]);
  rows.push(["— Peer disclosure —", ...columns.map(() => "")]);
  rows.push(["Primary peer count", ...columns.map((c) => c.primaryPeers)]);

  rows.push([]);
  rows.push(["— Pay ratio (Item 402(u)) —", ...columns.map(() => "")]);
  rows.push(["CEO pay ratio", ...columns.map((c) => c.metrics.ceoPayRatio)]);
  rows.push([
    "Median employee compensation",
    ...columns.map((c) => c.metrics.medianEmployeeComp),
  ]);

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
  rows.push([
    "Stock ownership guidelines",
    ...columns.map((c) => c.policies.stockOwnership),
  ]);
  rows.push(["Change in control", ...columns.map((c) => c.policies.changeInControl)]);
  rows.push([
    "Compensation consultant",
    ...columns.map((c) => c.policies.compConsultant),
  ]);
  rows.push([
    "Compensation committee",
    ...columns.map((c) => c.policies.compCommittee),
  ]);

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
