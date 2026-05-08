"use client";

/**
 * One-click CSV export of a single company's loaded filing. Bundles the
 * SCT rows, peer-group memberships, policy facts, and metric facts in
 * one wide CSV — easier to paste into a comp deck than the read-only
 * page view.
 */
import type { CompanyRow, FilingDetail } from "@/lib/types";

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replaceAll("\"", "\"\"")}"`;
  }
  return s;
}

function buildCsv(company: CompanyRow, latest: FilingDetail, prior: FilingDetail | null): string {
  const lines: string[] = [];
  const meta = [
    ["Company", company.name],
    ["Ticker", company.ticker ?? ""],
    ["CIK", company.cik],
    ["Filing year", String(latest.filing_year)],
    ["Form type", latest.form_type],
    ["Accession", latest.accession_number],
    ["Filing URL", latest.primary_document_url ?? ""],
  ];
  for (const [k, v] of meta) lines.push(`${csvCell(k)},${csvCell(v)}`);
  lines.push("");

  // SCT rows
  lines.push("== Summary Compensation Table ==");
  lines.push(
    [
      "Executive",
      "Position",
      "Year",
      "Salary",
      "Bonus",
      "Stock awards",
      "Option awards",
      "Non-equity incentive",
      "All other comp",
      "Total",
    ]
      .map(csvCell)
      .join(","),
  );
  for (const r of latest.executive_compensation) {
    lines.push(
      [
        r.executive_name,
        r.principal_position ?? "",
        r.year,
        r.salary ?? "",
        r.bonus ?? "",
        r.stock_awards ?? "",
        r.option_awards ?? "",
        r.non_equity_incentive_plan_compensation ?? "",
        r.all_other_compensation ?? "",
        r.total ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push("");

  // Prior year SCT (for YoY work in spreadsheet)
  if (prior && prior.executive_compensation.length > 0) {
    lines.push(`== Prior filing (${prior.filing_year}) Summary Compensation Table ==`);
    lines.push(
      [
        "Executive",
        "Position",
        "Year",
        "Salary",
        "Bonus",
        "Stock awards",
        "Option awards",
        "Non-equity incentive",
        "All other comp",
        "Total",
      ]
        .map(csvCell)
        .join(","),
    );
    for (const r of prior.executive_compensation) {
      lines.push(
        [
          r.executive_name,
          r.principal_position ?? "",
          r.year,
          r.salary ?? "",
          r.bonus ?? "",
          r.stock_awards ?? "",
          r.option_awards ?? "",
          r.non_equity_incentive_plan_compensation ?? "",
          r.all_other_compensation ?? "",
          r.total ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    lines.push("");
  }

  // Peer groups
  lines.push("== Peer groups ==");
  lines.push(["Group", "Type", "Year", "Member name", "Resolved name", "Ticker", "CIK"].map(csvCell).join(","));
  for (const g of latest.peer_groups) {
    for (const m of g.members) {
      lines.push(
        [
          g.peer_group_name ?? "",
          g.peer_group_type ?? "",
          g.disclosed_year ?? "",
          m.company_name_raw,
          m.company_name_resolved ?? "",
          m.ticker_resolved ?? "",
          m.cik_resolved ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  lines.push("");

  // Policies
  lines.push("== Policies ==");
  lines.push(["Type", "Normalized value", "Source excerpt"].map(csvCell).join(","));
  for (const p of latest.policies) {
    lines.push([p.policy_type, p.normalized_value ?? "", p.source_excerpt].map(csvCell).join(","));
  }
  lines.push("");

  // Metrics
  lines.push("== Metric facts ==");
  lines.push(["Metric", "Category", "Plan type", "Observed value", "Source excerpt"].map(csvCell).join(","));
  for (const m of latest.metrics) {
    lines.push(
      [
        m.metric_name_normalized ?? m.metric_name_raw,
        m.metric_category ?? "",
        m.plan_type ?? "",
        m.observed_value ?? "",
        m.source_excerpt,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return lines.join("\n");
}

export default function CompanyCsvButton({
  company,
  latest,
  prior,
}: {
  company: CompanyRow;
  latest: FilingDetail;
  prior: FilingDetail | null;
}) {
  function download() {
    const csv = buildCsv(company, latest, prior);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `proxyminer-${company.id}-${latest.filing_year}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-md border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] hover:border-accent"
      style={{ borderColor: "var(--line)", color: "var(--text)" }}
    >
      Export CSV
    </button>
  );
}
