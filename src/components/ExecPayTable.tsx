import type { ExecutiveCompRow } from "@/lib/types";

interface PayMix {
  basePct: number;
  bonusPct: number;
  equityPct: number;
  otherPct: number;
  atRiskPct: number;
}

function magnitude(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(String(v).replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : null;
}

function payMix(r: ExecutiveCompRow): PayMix | null {
  const base = magnitude(r.salary) ?? 0;
  const bonus =
    (magnitude(r.bonus) ?? 0) +
    (magnitude(r.non_equity_incentive_plan_compensation) ?? 0);
  const equity =
    (magnitude(r.stock_awards) ?? 0) + (magnitude(r.option_awards) ?? 0);
  const other = magnitude(r.all_other_compensation) ?? 0;
  const sum = base + bonus + equity + other;
  if (sum <= 0) return null;
  return {
    basePct: Math.round((base / sum) * 100),
    bonusPct: Math.round((bonus / sum) * 100),
    equityPct: Math.round((equity / sum) * 100),
    otherPct: Math.round((other / sum) * 100),
    atRiskPct: Math.round(((bonus + equity) / sum) * 100),
  };
}

function yoyDelta(
  current: string | null | undefined,
  prior: string | null | undefined,
): { pct: number; direction: "up" | "down" | "flat" } | null {
  const a = magnitude(current);
  const b = magnitude(prior);
  if (a == null || b == null || b === 0) return null;
  const pct = ((a - b) / b) * 100;
  if (!Number.isFinite(pct)) return null;
  return {
    pct: Math.round(pct),
    direction: pct > 1 ? "up" : pct < -1 ? "down" : "flat",
  };
}

function fmt(value: string | null | undefined): string {
  if (!value) return "—";
  return value.startsWith("$") ? value : `$${value}`;
}

function priorityRank(position: string | null | undefined): number {
  const lower = (position ?? "").toLowerCase();
  if (lower.includes("chief executive officer")) return 0;
  if (lower.includes("chief financial officer")) return 1;
  return 2;
}

export interface ExecPayTableProps {
  rows: ExecutiveCompRow[];
  priorRows?: ExecutiveCompRow[];
  filingYear: number | null;
}

export default function ExecPayTable({
  rows,
  priorRows = [],
  filingYear,
}: ExecPayTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        No executive compensation table extracted from this filing yet.
      </p>
    );
  }

  // Show only the latest reported year per executive (the SCT typically
  // covers 3 years per row; the most recent is the one users want first).
  const latestYear =
    filingYear ?? Math.max(...rows.map((r) => r.year));
  const latestRows = rows
    .filter((r) => r.year === latestYear)
    .sort((a, b) => {
      const pri = priorityRank(a.principal_position) - priorityRank(b.principal_position);
      if (pri !== 0) return pri;
      return (magnitude(b.total) ?? 0) - (magnitude(a.total) ?? 0);
    });

  const priorByName = new Map<string, ExecutiveCompRow>();
  const priorYear = priorRows.length
    ? Math.max(...priorRows.map((r) => r.year))
    : null;
  if (priorYear !== null) {
    for (const r of priorRows) {
      if (r.year !== priorYear) continue;
      priorByName.set(r.executive_name.trim().toLowerCase(), r);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left">
            <Th>Executive</Th>
            <Th>Role</Th>
            <Th>
              Total
              <span
                className="ml-2 rounded-full border px-1.5 py-0.5 align-middle text-[9px] uppercase tracking-[0.16em]"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                title="Year-over-year change vs the prior proxy"
              >
                YoY
              </span>
            </Th>
            <Th title="Share of total pay that is variable (cash incentive + equity).">
              Pay mix
            </Th>
            <Th>Salary</Th>
            <Th>Stock</Th>
            <Th>Cash incentive</Th>
            <Th>Other</Th>
          </tr>
        </thead>
        <tbody>
          {latestRows.map((row) => {
            const isCEO = (row.principal_position ?? "")
              .toLowerCase()
              .includes("chief executive officer");
            const prior = priorByName.get(
              row.executive_name.trim().toLowerCase(),
            );
            const delta = prior ? yoyDelta(row.total, prior.total) : null;
            const mix = payMix(row);
            return (
              <tr
                key={`${row.executive_name}-${row.year}`}
                className={`border-t ${isCEO ? "font-medium" : ""}`}
                style={{ borderColor: "var(--line)" }}
              >
                <Td>
                  <div className="flex flex-col">
                    <span style={{ color: "var(--text)" }}>
                      {row.executive_name}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                      {row.year} compensation
                    </span>
                  </div>
                </Td>
                <Td>
                  <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                    {row.principal_position ?? "Named executive officer"}
                  </span>
                </Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <strong className="text-base">{fmt(row.total)}</strong>
                    {delta ? (
                      <span
                        className={`yoy-pill is-${delta.direction}`}
                        title={`vs ${prior?.year ?? "prior year"}: ${fmt(prior?.total)}`}
                      >
                        {delta.direction === "up"
                          ? "↑"
                          : delta.direction === "down"
                            ? "↓"
                            : "→"}{" "}
                        {Math.abs(delta.pct)}%
                      </span>
                    ) : null}
                  </div>
                </Td>
                <Td>
                  {mix ? (
                    <div
                      className="flex w-40 flex-col gap-1"
                      title={`Base ${mix.basePct}% · Cash incentive ${mix.bonusPct}% · Equity ${mix.equityPct}% · Other ${mix.otherPct}% · At-risk ${mix.atRiskPct}%`}
                    >
                      <div className="pay-mix-bar" aria-hidden>
                        {mix.basePct > 0 ? (
                          <span
                            className="pay-mix-seg is-base"
                            style={{ width: `${mix.basePct}%` }}
                          />
                        ) : null}
                        {mix.bonusPct > 0 ? (
                          <span
                            className="pay-mix-seg is-bonus"
                            style={{ width: `${mix.bonusPct}%` }}
                          />
                        ) : null}
                        {mix.equityPct > 0 ? (
                          <span
                            className="pay-mix-seg is-equity"
                            style={{ width: `${mix.equityPct}%` }}
                          />
                        ) : null}
                        {mix.otherPct > 0 ? (
                          <span
                            className="pay-mix-seg is-other"
                            style={{ width: `${mix.otherPct}%` }}
                          />
                        ) : null}
                      </div>
                      <span
                        className="text-[10px] uppercase tracking-[0.12em]"
                        style={{ color: "var(--muted)" }}
                      >
                        {mix.atRiskPct}% at-risk
                      </span>
                    </div>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </Td>
                <Td>{fmt(row.salary)}</Td>
                <Td>{fmt(row.stock_awards)}</Td>
                <Td>{fmt(row.non_equity_incentive_plan_compensation)}</Td>
                <Td>{fmt(row.all_other_compensation)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Legend />
    </div>
  );
}

function Th({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <th
      title={title}
      className="border-b py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.12em]"
      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-3 pr-4 align-top">{children}</td>;
}

function Legend() {
  return (
    <p
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
      style={{ color: "var(--muted)" }}
    >
      <span>Pay mix:</span>
      <Dot className="is-base" /> base
      <Dot className="is-bonus" /> cash incentive
      <Dot className="is-equity" /> equity
      <Dot className="is-other" /> other
    </p>
  );
}

function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`pay-mix-seg ${className} inline-block h-2 w-2 rounded-sm`}
    />
  );
}
