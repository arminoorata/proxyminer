/**
 * Peer-comparison workspace. Side-by-side view of up to 6 companies
 * across the canonical executive-comp axes a Total Rewards analyst
 * needs when sanity-checking peer practice for the comp committee.
 *
 *   /compare?companies=aapl,msft,googl,meta&year=2025
 *
 * The companies query param drives the column set (≤ 6). The year
 * param picks the most-recent filing year ≤ that target; we fall
 * through to the next available filing if the requested year is
 * missing for a company. Each cell carries provenance back to the
 * underlying filing artifact, so the page is itself source-grounded.
 */
import Link from "next/link";

import CompareCsvButton from "@/components/CompareCsvButton";
import CompanyMultiPicker from "@/components/CompanyMultiPicker";
import { getCompany, getFilingDetail, listCompanies, listFilings } from "@/lib/data/source";
import {
  factSourceLabel,
  factSourceSection,
  factSourceTooltip,
} from "@/lib/extractors/fact-source";
import { isCeoPosition } from "@/lib/exec/ceo";
import type { CompanyRow, FilingDetail } from "@/lib/types";

const MAX_COMPANIES = 6;

interface ColumnData {
  company: CompanyRow;
  filing: FilingDetail | null;
}

function pickFiling(detail: FilingDetail | null, list: FilingDetail[]): FilingDetail | null {
  return detail ?? list[0] ?? null;
}

function magnitude(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(String(v).replaceAll(",", "").replaceAll("$", ""));
  return Number.isFinite(n) ? n : null;
}

function fmtCurrency(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtPct(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

interface PayMix {
  base: number;
  bonus: number;
  equity: number;
  other: number;
  total: number;
}

function ceoPayMix(filing: FilingDetail | null): PayMix | null {
  if (!filing) return null;
  const latestYear = filing.executive_compensation.length
    ? Math.max(...filing.executive_compensation.map((r) => r.year))
    : null;
  if (latestYear === null) return null;
  const ceo = filing.executive_compensation.find(
    (r) =>
      r.year === latestYear && isCeoPosition(r.principal_position),
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

/**
 * Render a metric or policy with a short provenance badge that shows
 * which section it was extracted from. Used by the compare grid so
 * analysts can tell at a glance whether a pay ratio came from CD&A
 * or the standalone Item 402(u) section.
 */
function MetricCell({ filing, normalized }: { filing: FilingDetail | null; normalized: string }) {
  if (!filing) return <>—</>;
  const m = filing.metrics.find((x) => x.metric_name_normalized === normalized);
  if (!m) return <>Not extracted</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span>{m.observed_value ?? "Disclosed"}</span>
      <SourceChip extractionMethod={m.extraction_method} />
    </span>
  );
}

function PolicyCell({ filing, type }: { filing: FilingDetail | null; type: string }) {
  if (!filing) return <>—</>;
  const p = filing.policies.find((x) => x.policy_type === type);
  if (!p) return <>Not extracted</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span>{p.normalized_value ?? p.summary ?? "Disclosed"}</span>
      <SourceChip extractionMethod={p.extraction_method} />
    </span>
  );
}

function SourceChip({ extractionMethod }: { extractionMethod: string | null }) {
  // Default (CD&A) — don't render a chip; reserve the chip for cases
  // where the fact came from a dedicated post-CD&A section so the
  // signal stands out instead of becoming visual noise.
  const section = factSourceSection(extractionMethod);
  if (section === "cd_and_a") return null;
  return (
    <span
      title={factSourceTooltip(extractionMethod)}
      className="rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
    >
      {factSourceLabel(extractionMethod)}
    </span>
  );
}

function ceoTotal(filing: FilingDetail | null): { exec: string; total: number; year: number } | null {
  if (!filing) return null;
  const latestYear = filing.executive_compensation.length
    ? Math.max(...filing.executive_compensation.map((r) => r.year))
    : null;
  if (latestYear === null) return null;
  const ceo = filing.executive_compensation.find(
    (r) =>
      r.year === latestYear && isCeoPosition(r.principal_position),
  );
  if (!ceo) return null;
  const total = magnitude(ceo.total) ?? 0;
  // Strip trailing position-prefix fragments the upstream extractor
  // may have merged into executive_name (e.g., "Sundar PichaiChief").
  const exec = ceo.executive_name
    .replace(/\s*(Chief|President|Senior Vice President|SVP|EVP)\s*$/, "")
    .trim();
  return { exec, total, year: ceo.year };
}

function neoCount(filing: FilingDetail | null): number {
  if (!filing) return 0;
  const latestYear = filing.executive_compensation.length
    ? Math.max(...filing.executive_compensation.map((r) => r.year))
    : null;
  if (latestYear === null) return 0;
  return filing.executive_compensation.filter((r) => r.year === latestYear).length;
}

function primaryPeerCount(filing: FilingDetail | null): number {
  if (!filing) return 0;
  const primary =
    filing.peer_groups.find((g) => g.peer_group_type === "primary") ?? filing.peer_groups[0];
  return primary?.members.length ?? 0;
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const ids = String(params.companies ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_COMPANIES);
  const yearFilter =
    typeof params.year === "string" && /^\d{4}$/.test(params.year)
      ? Number.parseInt(params.year, 10)
      : null;

  const allCompanies = await listCompanies();

  // Resolve each ID into (company, filingDetail). Pick the most-recent
  // filing whose year ≤ yearFilter when set, else the most-recent.
  const columns: ColumnData[] = await Promise.all(
    ids.map(async (id) => {
      const company = await getCompany(id);
      if (!company) return { company: { id, cik: "", ticker: null, name: id, sector: null }, filing: null };
      const filings = await listFilings(id);
      const eligible = yearFilter
        ? filings.filter((f) => f.filing_year <= yearFilter)
        : filings;
      const target = (eligible[0] ?? filings[0])?.id;
      const detail = target ? await getFilingDetail(target) : null;
      const list = await Promise.all(
        filings.map(async (f) => await getFilingDetail(f.id)),
      );
      return { company, filing: pickFiling(detail, list.filter(Boolean) as FilingDetail[]) };
    }),
  );

  const empty = columns.length === 0;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10 md:px-10 md:py-14">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p
            className="text-xs font-medium uppercase tracking-[0.32em]"
            style={{ color: "var(--accent)" }}
          >
            ProxyMiner / Compare
          </p>
          <h1 className="mt-3 text-3xl font-semibold md:text-4xl">Peer comparison</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Side-by-side CD&amp;A and pay-practice signals across up to {MAX_COMPANIES} companies.
            Each cell traces back to the underlying proxy filing.
          </p>
        </div>
        <Link href="/" className="text-xs uppercase tracking-[0.16em] hover:underline">
          ← Home
        </Link>
      </header>

      <section className="mt-8">
        <CompanyMultiPicker
          allCompanies={allCompanies}
          selectedIds={ids}
          maxCompanies={MAX_COMPANIES}
        />
      </section>

      {empty ? (
        <section className="mt-12 rounded-md border p-8 text-center" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Pick at least two companies above to start a comparison.
          </p>
        </section>
      ) : (
        <section className="mt-10 overflow-x-auto">
          <div className="mb-3 flex justify-end">
            <CompareCsvButton columns={columns.map((c) => ({
              companyId: c.company.id,
              companyName: c.company.name,
              ticker: c.company.ticker,
              filingYear: c.filing?.filing_year ?? null,
              filingUrl: c.filing?.primary_document_url ?? null,
              ceoName: ceoTotal(c.filing)?.exec ?? null,
              ceoTotal: ceoTotal(c.filing)?.total ?? null,
              ceoYear: ceoTotal(c.filing)?.year ?? null,
              neoCount: neoCount(c.filing),
              primaryPeers: primaryPeerCount(c.filing),
              policies: {
                hedging: findPolicy(c.filing, "hedging"),
                pledging: findPolicy(c.filing, "pledging"),
                clawback: findPolicy(c.filing, "clawback"),
                stockOwnership: findPolicy(c.filing, "stock_ownership_guidelines"),
                changeInControl: findPolicy(c.filing, "change_in_control"),
                compConsultant: findPolicy(c.filing, "compensation_consultant"),
                compCommittee: findPolicy(c.filing, "compensation_committee"),
              },
              metrics: {
                sayOnPay: findMetric(c.filing, "say_on_pay"),
                relativeTsr: findMetric(c.filing, "relative_tsr"),
                revenue: findMetric(c.filing, "revenue"),
                operatingIncome: findMetric(c.filing, "operating_income"),
                annualIncentive: findMetric(c.filing, "annual_incentive_payout"),
                rsuVesting: findMetric(c.filing, "performance_rsu_vesting"),
                performanceMix: findMetric(c.filing, "performance_equity_mix"),
                timeMix: findMetric(c.filing, "time_equity_mix"),
                ceoPayRatio: findMetric(c.filing, "ceo_pay_ratio"),
                medianEmployeeComp: findMetric(c.filing, "median_employee_compensation"),
              },
              payMix: ceoPayMix(c.filing),
            }))} />
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th
                  className="sticky left-0 z-10 border-b px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em]"
                  style={{ borderColor: "var(--line)", color: "var(--accent)", background: "var(--bg)" }}
                >
                  Axis
                </th>
                {columns.map((c) => (
                  <th
                    key={c.company.id}
                    className="border-b px-3 py-3 text-left"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <Link
                      href={`/company/${c.company.id}`}
                      className="text-sm font-semibold hover:underline"
                      style={{ color: "var(--text)" }}
                    >
                      {c.company.name}
                    </Link>
                    {c.company.ticker ? (
                      <p
                        className="mt-0.5 font-mono text-[11px]"
                        style={{ color: "var(--muted)" }}
                      >
                        {c.company.ticker} ·{" "}
                        {c.filing
                          ? c.filing.primary_document_url
                            ? (
                                <a
                                  href={c.filing.primary_document_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline"
                                  style={{ color: "var(--accent)" }}
                                >
                                  {c.filing.filing_year} proxy ↗
                                </a>
                              )
                            : `${c.filing.filing_year} proxy`
                          : "no filing"}
                      </p>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionHeading colSpan={columns.length}>Executive pay</SectionHeading>
              <Row label="CEO" cols={columns}>
                {(c) => {
                  const t = ceoTotal(c.filing);
                  if (!t) return "—";
                  return (
                    <>
                      <strong style={{ color: "var(--text)" }}>{t.exec}</strong>
                      <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {fmtCurrency(t.total)} · {t.year}
                      </p>
                    </>
                  );
                }}
              </Row>
              <Row label="NEOs reported" cols={columns}>
                {(c) => String(neoCount(c.filing))}
              </Row>
              <Row label="Pay mix (CEO)" cols={columns}>
                {(c) => {
                  const m = ceoPayMix(c.filing);
                  if (!m) return "—";
                  return (
                    <span className="font-mono text-[11px]" style={{ color: "var(--text)" }}>
                      Base {fmtPct(m.base, m.total)} · Cash {fmtPct(m.bonus, m.total)} · Equity{" "}
                      {fmtPct(m.equity, m.total)} · Other {fmtPct(m.other, m.total)}
                    </span>
                  );
                }}
              </Row>
              <Row label="At-risk %" cols={columns}>
                {(c) => {
                  const m = ceoPayMix(c.filing);
                  if (!m) return "—";
                  return fmtPct(m.bonus + m.equity, m.total);
                }}
              </Row>

              <SectionHeading colSpan={columns.length}>Peer disclosure</SectionHeading>
              <Row label="Primary peer count" cols={columns}>
                {(c) => String(primaryPeerCount(c.filing))}
              </Row>
              <Row label="Peer group type(s) named" cols={columns}>
                {(c) => {
                  if (!c.filing) return "—";
                  const types = Array.from(
                    new Set(c.filing.peer_groups.map((g) => g.peer_group_type ?? "—")),
                  );
                  return types.length ? types.join(" · ") : "—";
                }}
              </Row>

              <SectionHeading colSpan={columns.length}>Pay ratio (Item 402(u))</SectionHeading>
              <Row label="CEO pay ratio" cols={columns}>
                {(c) => <MetricCell filing={c.filing} normalized="ceo_pay_ratio" />}
              </Row>
              <Row label="Median employee compensation" cols={columns}>
                {(c) => <MetricCell filing={c.filing} normalized="median_employee_compensation" />}
              </Row>

              <SectionHeading colSpan={columns.length}>Performance metrics</SectionHeading>
              <Row label="Say on pay support" cols={columns}>
                {(c) => <MetricCell filing={c.filing} normalized="say_on_pay" />}
              </Row>
              <Row label="Relative TSR" cols={columns}>
                {(c) => findMetric(c.filing, "relative_tsr")}
              </Row>
              <Row label="Revenue (disclosed)" cols={columns}>
                {(c) => findMetric(c.filing, "revenue")}
              </Row>
              <Row label="Operating income" cols={columns}>
                {(c) => findMetric(c.filing, "operating_income")}
              </Row>
              <Row label="Annual incentive payout" cols={columns}>
                {(c) => findMetric(c.filing, "annual_incentive_payout")}
              </Row>
              <Row label="Performance RSU vesting" cols={columns}>
                {(c) => findMetric(c.filing, "performance_rsu_vesting")}
              </Row>
              <Row label="LTI mix · performance" cols={columns}>
                {(c) => findMetric(c.filing, "performance_equity_mix")}
              </Row>
              <Row label="LTI mix · time" cols={columns}>
                {(c) => findMetric(c.filing, "time_equity_mix")}
              </Row>

              <SectionHeading colSpan={columns.length}>Governance</SectionHeading>
              <Row label="Hedging policy" cols={columns}>
                {(c) => findPolicy(c.filing, "hedging")}
              </Row>
              <Row label="Pledging policy" cols={columns}>
                {(c) => findPolicy(c.filing, "pledging")}
              </Row>
              <Row label="Clawback" cols={columns}>
                {(c) => findPolicy(c.filing, "clawback")}
              </Row>
              <Row label="Stock ownership guidelines" cols={columns}>
                {(c) => findPolicy(c.filing, "stock_ownership_guidelines")}
              </Row>
              <Row label="Change-in-control gross-ups" cols={columns}>
                {(c) => findPolicy(c.filing, "change_in_control")}
              </Row>
              <Row label="Compensation consultant" cols={columns}>
                {(c) => findPolicy(c.filing, "compensation_consultant")}
              </Row>
              <Row label="Compensation committee" cols={columns}>
                {(c) => <PolicyCell filing={c.filing} type="compensation_committee" />}
              </Row>
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-6 text-xs italic" style={{ color: "var(--muted)" }}>
        Cells reading &ldquo;Not extracted&rdquo; mean the deterministic extractor didn&rsquo;t pick
        up this disclosure for the latest loaded filing. Open the company workspace and use Ask to
        query the CD&amp;A directly with citations.
      </p>
    </main>
  );
}

function SectionHeading({ children, colSpan }: { children: React.ReactNode; colSpan: number }) {
  return (
    <tr>
      <th
        colSpan={colSpan + 1}
        className="border-t border-b px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em]"
        style={{ borderColor: "var(--line)", color: "var(--accent)", background: "var(--surface-alt)" }}
      >
        {children}
      </th>
    </tr>
  );
}

function Row({
  label,
  cols,
  children,
}: {
  label: string;
  cols: ColumnData[];
  children: (col: ColumnData) => React.ReactNode;
}) {
  return (
    <tr>
      <th
        className="sticky left-0 z-10 border-b px-3 py-2.5 text-left text-[12px] font-medium"
        style={{ borderColor: "var(--line)", color: "var(--muted)", background: "var(--bg)" }}
      >
        {label}
      </th>
      {cols.map((c) => (
        <td
          key={c.company.id}
          className="border-b px-3 py-2.5 align-top text-[13px]"
          style={{ borderColor: "var(--line)", color: "var(--text)" }}
        >
          {children(c)}
        </td>
      ))}
    </tr>
  );
}
