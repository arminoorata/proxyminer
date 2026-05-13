import Link from "next/link";
import { notFound } from "next/navigation";

import AskBox from "@/components/AskBox";
import CompanyCsvButton from "@/components/CompanyCsvButton";
import ExecPayTable from "@/components/ExecPayTable";
import {
  getCompany,
  getLatestFiling,
  listFilings,
  getFilingDetail,
} from "@/lib/data/source";
import { factSourceLabel, factSourceTooltip } from "@/lib/extractors/fact-source";
import { isCeoPosition } from "@/lib/exec/ceo";

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const company = await getCompany(companyId);
  if (!company) notFound();

  const filings = await listFilings(companyId);
  const latest = await getLatestFiling(companyId);
  if (!latest) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 md:px-10">
        <h1 className="text-3xl font-semibold">{company.name}</h1>
        <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
          We don&apos;t have any filings ingested for this company yet.
        </p>
      </main>
    );
  }

  // Optionally pull the prior year for YoY comparisons.
  const priorFilingId = filings[1]?.id ?? null;
  const prior = priorFilingId ? await getFilingDetail(priorFilingId) : null;

  // CEO identification accepts both the full phrase ("Chief Executive
  // Officer") and the acronym ("CEO" / "Chair and CEO"). See
  // lib/exec/ceo.ts for the full predicate.
  const ceoRaw = latest.executive_compensation
    .filter((r) => r.year === Math.max(...latest.executive_compensation.map((x) => x.year)))
    .find((r) => isCeoPosition(r.principal_position));
  // When the upstream extractor merged "Chief" / "Chairman" / "co-"
  // into the name (cell-wrap collapse), strip the trailing title
  // fragment for display. NFLX "TED SARANDOSco-" is the canonical
  // case; the trailing-"co-" rule handles it.
  const ceo = ceoRaw
    ? {
        ...ceoRaw,
        executive_name: ceoRaw.executive_name
          .replace(
            /\s*(co-?|Chief|President|Senior Vice President|SVP|EVP|Chairman|Chair)\s*$/i,
            "",
          )
          .trim(),
      }
    : undefined;
  // ORCL-style transition note: when the latest CEO row's position
  // explicitly marks them as "Former" / "Outgoing" / "Retired", the
  // row is still correct for the disclosed year (they WERE CEO during
  // it) but the surface should annotate the transition.
  const ceoTransitioned = ceo
    ? /\b(Former|Outgoing|Retired)\b.*\b(Chief\s+Executive|CEO)\b/i.test(
        ceo.principal_position ?? "",
      )
    : false;

  const sayOnPay = latest.metrics.find(
    (m) =>
      (m.metric_name_normalized ?? "").toLowerCase() === "say_on_pay" ||
      m.metric_name_raw.toLowerCase().includes("say on pay"),
  );
  const payRatio = latest.metrics.find(
    (m) => m.metric_name_normalized === "ceo_pay_ratio",
  );
  const medianEmp = latest.metrics.find(
    (m) => m.metric_name_normalized === "median_employee_compensation",
  );
  const compCommittee = latest.policies.find(
    (p) => p.policy_type === "compensation_committee",
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p
            className="text-xs font-medium uppercase tracking-[0.32em]"
            style={{ color: "var(--accent)" }}
          >
            ProxyMiner / Company
          </p>
          <h1 className="mt-3 text-3xl font-semibold md:text-4xl">
            {company.name}
            {company.ticker ? (
              <span
                className="ml-3 align-middle font-mono text-base"
                style={{ color: "var(--muted)" }}
              >
                {company.ticker}
              </span>
            ) : null}
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Latest proxy: {latest.filing_year} ·{" "}
            <FilingLink filing={latest} /> · CIK {company.cik}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <a
            href={`/api/company/${companyId}/export.pdf`}
            className="rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:bg-[var(--surface)]"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
            title="Download an analyst-pack PDF: headline facts, exec pay table, pay mix, source citations."
          >
            ↓ Export PDF
          </a>
          <Link href="/" className="text-xs uppercase tracking-[0.16em] hover:underline">
            ← All companies
          </Link>
        </div>
      </header>

      <section className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="CEO total pay"
          value={ceo ? formatTotal(ceo.total) : "—"}
          badge={ceoTransitioned ? "Transitioned" : undefined}
          badgeTitle={
            ceoTransitioned
              ? `Disclosed as ${ceo?.principal_position ?? "former CEO"}; the row reflects compensation during the year of transition.`
              : undefined
          }
        >
          {ceo ? `${ceo.executive_name} · ${ceo.year}` : "Not extracted"}
        </Stat>
        <Stat
          label="Say on pay"
          value={sayOnPay?.observed_value ?? "Not disclosed"}
        >
          {sayOnPay ? "Latest disclosed shareholder vote" : "Use Ask for the underlying narrative"}
        </Stat>
        <Stat
          label="CEO pay ratio"
          value={payRatio?.observed_value ?? "Not in CD&A"}
          badge={payRatio ? factSourceLabel(payRatio.extraction_method) : undefined}
          badgeTitle={payRatio ? factSourceTooltip(payRatio.extraction_method) : undefined}
        >
          {medianEmp?.observed_value
            ? `Median employee: ${medianEmp.observed_value}`
            : "Item 402(u) section may live outside the CD&A"}
        </Stat>
        <Stat
          label="Compensation committee"
          value={compCommittee?.normalized_value ?? "Not extracted"}
          badge={compCommittee ? factSourceLabel(compCommittee.extraction_method) : undefined}
          badgeTitle={compCommittee ? factSourceTooltip(compCommittee.extraction_method) : undefined}
        >
          {compCommittee
            ? "Per the latest proxy"
            : "Use Ask to query the committee narrative"}
        </Stat>
      </section>
      <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
        Filings indexed: {filings.length} · {filings.map((f) => f.filing_year).slice(0, 5).join(" · ")}
      </p>

      <section className="mt-12">
        <SectionHeader
          kicker="Executive pay"
          title="What did they pay them?"
          hint="From the Summary Compensation Table. Pay mix and YoY are computed from these rows."
        />
        <div className="mt-6">
          <ExecPayTable
            rows={latest.executive_compensation}
            priorRows={prior?.executive_compensation ?? []}
            filingYear={null}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <CompanyCsvButton company={company} latest={latest} prior={prior} />
            <Link
              href={`/compare?companies=${company.id}`}
              className="text-[11px] uppercase tracking-[0.16em] hover:underline"
              style={{ color: "var(--accent)" }}
            >
              Add to peer comparison →
            </Link>
            {filings.length >= 2 ? (
              <Link
                href={`/company/${company.id}/diff`}
                className="text-[11px] uppercase tracking-[0.16em] hover:underline"
                style={{ color: "var(--accent)" }}
              >
                Year-over-year diff →
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      {(() => {
        const cda = latest.sections.find((s) => s.section_type === "cd_and_a");
        if (!cda) return null;
        const trimmed = cda.text.replace(/\s+/g, " ").trim();
        const opener = trimmed.slice(0, 1200);
        return (
          <section className="mt-12">
            <SectionHeader
              kicker="CD&A excerpt"
              title="Compensation discussion &amp; analysis"
              hint="Opening passage of the loaded filing's CD&A. Use Ask below to query the full text with citations."
            />
            <div
              className="mt-6 rounded-lg border p-5 text-sm leading-relaxed"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            >
              {opener}
              {trimmed.length > 1200 ? "…" : ""}
              {latest.primary_document_url ? (
                <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
                  Read the full CD&amp;A on{" "}
                  <a
                    href={latest.primary_document_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    SEC.gov ↗
                  </a>
                </p>
              ) : null}
            </div>
          </section>
        );
      })()}

      {latest.peer_groups.length > 0 ? (
        <section className="mt-12">
          <SectionHeader
            kicker="Peer comparison"
            title="Who they benchmark against"
          />
          <ul
            className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
            style={{ color: "var(--muted)" }}
          >
            {latest.peer_groups.map((g, i) => (
              <li
                key={i}
                className="rounded-lg border p-4"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
                  {g.peer_group_name ?? "Peer group"}
                </p>
                <p className="mt-1 text-xs">
                  {g.members.length} members
                </p>
                <p className="mt-2 text-xs leading-relaxed">
                  {g.members
                    .slice(0, 8)
                    .map((m) => m.company_name_resolved ?? m.company_name_raw)
                    .join(" · ")}
                  {g.members.length > 8 ? " · …" : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {latest.policies.length > 0 ? (
        <section className="mt-12">
          <SectionHeader kicker="Governance" title="Policy guardrails" />
          <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {latest.policies.map((p) => (
              <li
                key={`${p.policy_type}-${String(p.id ?? p.normalized_value ?? "")}`}
                className="rounded-lg border p-4"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--accent)" }}>
                  {p.policy_type.replace(/_/g, " ")}
                </p>
                <p className="mt-1 text-sm" style={{ color: "var(--text)" }}>
                  {p.normalized_value ?? p.summary ?? "—"}
                </p>
                {p.source_excerpt ? (
                  <p
                    className="mt-2 text-xs leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    “{p.source_excerpt.slice(0, 220)}
                    {p.source_excerpt.length > 220 ? "…" : ""}”
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {latest.metrics.length > 0 ? (
        <section className="mt-12">
          <SectionHeader kicker="Performance markers" title="Metric facts" />
          <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {latest.metrics.map((m) => (
              <li
                key={`${m.metric_name_raw}-${String(m.id ?? "")}`}
                className="rounded-lg border p-4"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "var(--accent)" }}
                >
                  {(m.metric_name_normalized ?? m.metric_name_raw).replace(/_/g, " ")}
                </p>
                <p className="mt-1 text-sm" style={{ color: "var(--text)" }}>
                  {m.observed_value ?? "—"}
                </p>
                {m.source_excerpt ? (
                  <p
                    className="mt-2 text-xs leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    “{m.source_excerpt.slice(0, 220)}
                    {m.source_excerpt.length > 220 ? "…" : ""}”
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-12">
        <AskBox
          companyId={company.id}
          companyName={company.name}
          filingId={latest.id}
          filingYear={latest.filing_year}
        />
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  badge,
  badgeTitle,
  children,
}: {
  label: string;
  value: string;
  /** Optional provenance chip rendered next to the label. */
  badge?: string;
  badgeTitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-center gap-2">
        <p
          className="text-[11px] font-medium uppercase tracking-[0.18em]"
          style={{ color: "var(--accent)" }}
        >
          {label}
        </p>
        {badge ? (
          <span
            title={badgeTitle}
            className="rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-2xl font-semibold" style={{ color: "var(--text)" }}>
        {value}
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        {children}
      </p>
    </div>
  );
}

function SectionHeader({
  kicker,
  title,
  hint,
}: {
  kicker: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p
        className="text-[11px] font-medium uppercase tracking-[0.18em]"
        style={{ color: "var(--accent)" }}
      >
        {kicker}
      </p>
      <h2 className="text-2xl font-semibold">{title}</h2>
      {hint ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function FilingLink({
  filing,
}: {
  filing: { primary_document_url: string | null; accession_number: string };
}) {
  if (!filing.primary_document_url) {
    return <>{filing.accession_number}</>;
  }
  return (
    <a
      href={filing.primary_document_url}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
      style={{ color: "var(--accent)" }}
    >
      view on SEC ↗
    </a>
  );
}

function formatTotal(value: string | null): string {
  if (!value) return "—";
  return value.startsWith("$") ? value : `$${value}`;
}
