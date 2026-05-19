import Link from "next/link";
import { notFound } from "next/navigation";

import AskBox from "@/components/AskBox";
import CompanyCsvButton from "@/components/CompanyCsvButton";
import ExecPayTable from "@/components/ExecPayTable";
import AddToPeerSetButton from "@/components/peer-set/AddToPeerSetButton";
import {
  getCompany,
  getLatestFiling,
  listCompanies,
  listFilings,
  getFilingDetail,
} from "@/lib/data/source";
import { factSourceLabel, factSourceTooltip } from "@/lib/extractors/fact-source";
import { isCeoPosition } from "@/lib/exec/ceo";
import { cleanExecutiveDisplayName } from "@/lib/exec/display";
import {
  buildSecNameIndex,
  matchPeerNameToSec,
} from "@/lib/services/peer-name-match";
import { getSecTickers } from "@/lib/services/sec-tickers-cache";

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
  // Centralized display-name cleanup; see lib/exec/display.ts.
  const ceo = ceoRaw
    ? {
        ...ceoRaw,
        executive_name: cleanExecutiveDisplayName(ceoRaw.executive_name),
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

  // Resolve each peer-group member to a SEC ticker so the UI can turn
  // peer chips into navigation: in-DB peers link to /company/<id>,
  // SEC-resolvable peers link to /import/<ticker> (kicks off the
  // durable ingest flow), and unresolved names fall back to plain
  // text. Skipped silently if the SEC cache cold-start fails.
  let secNameIndex: ReturnType<typeof buildSecNameIndex> = new Map();
  let importedIds: Set<string> = new Set();
  if (latest.peer_groups.length > 0) {
    try {
      const cache = await getSecTickers();
      secNameIndex = buildSecNameIndex(cache.entries);
      const rows = await listCompanies();
      importedIds = new Set(rows.map((c) => c.id));
    } catch (err) {
      console.warn("[company-page] peer resolution skipped:", err);
    }
  }
  type ResolvedPeer = {
    raw: string;
    company_id: string | null;     // null = couldn't resolve to a SEC ticker at all
    ticker: string | null;
    display_name: string;
    in_db: boolean;
  };
  function resolvePeer(
    m: { company_name_raw: string; company_id_resolved: string | null; company_name_resolved: string | null; ticker_resolved: string | null },
  ): ResolvedPeer {
    const display = m.company_name_resolved ?? m.company_name_raw;
    // Trust the extractor's resolution first (DB-cohort hit). For
    // unresolved peers, fall back to the SEC ticker universe.
    if (m.company_id_resolved && importedIds.has(m.company_id_resolved)) {
      return {
        raw: m.company_name_raw,
        company_id: m.company_id_resolved,
        ticker: m.ticker_resolved,
        display_name: display,
        in_db: true,
      };
    }
    const sec = matchPeerNameToSec(m.company_name_raw, secNameIndex);
    if (sec) {
      return {
        raw: m.company_name_raw,
        company_id: sec.company_id,
        ticker: sec.ticker,
        display_name: display,
        in_db: importedIds.has(sec.company_id),
      };
    }
    return {
      raw: m.company_name_raw,
      company_id: null,
      ticker: null,
      display_name: display,
      in_db: false,
    };
  }

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
          <div className="flex flex-wrap gap-2">
            <AddToPeerSetButton
              companyId={company.id}
              ticker={company.ticker}
              name={company.name}
            />
            <a
              href={`/api/company/${companyId}/export.pdf`}
              className="rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:bg-[var(--surface)]"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              title="Download an analyst-pack PDF: headline facts, exec pay table, pay mix, source citations."
            >
              ↓ Export PDF
            </a>
          </div>
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
            hint="Click any peer to jump to their proxy. Peers we haven't ingested yet kick off an import on click."
          />
          <ul
            className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
            style={{ color: "var(--muted)" }}
          >
            {latest.peer_groups.map((g, i) => {
              const resolved = g.members.map(resolvePeer);
              const importedCount = resolved.filter((p) => p.in_db).length;
              return (
                <li
                  key={i}
                  className="rounded-lg border p-4"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                >
                  <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
                    {g.peer_group_name ?? "Peer group"}
                  </p>
                  <p className="mt-1 text-xs">
                    {g.members.length} members · {importedCount} in ProxyMiner
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {resolved.map((peer, j) => (
                      <PeerChip key={j} peer={peer} />
                    ))}
                  </div>
                </li>
              );
            })}
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

interface ResolvedPeerChip {
  raw: string;
  company_id: string | null;
  ticker: string | null;
  display_name: string;
  in_db: boolean;
}

function PeerChip({ peer }: { peer: ResolvedPeerChip }) {
  const label = peer.ticker
    ? `${peer.ticker} · ${peer.display_name}`
    : peer.display_name;
  const baseClass =
    "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors";

  // Chips with a resolvable SEC ticker get a paired peer-set toggle
  // alongside the link. Chips without one are plain text (no action).
  if (peer.company_id) {
    const link = peer.in_db ? (
      <Link
        href={`/company/${peer.company_id}`}
        title={`Open ${peer.display_name} in ProxyMiner`}
        className={`${baseClass} hover:border-accent`}
        style={{
          borderColor: "var(--accent)",
          color: "var(--text)",
        }}
      >
        <span className="truncate">{label}</span>
      </Link>
    ) : (
      <Link
        href={`/import/${peer.company_id}`}
        title={`Import ${peer.display_name} from SEC`}
        className={`${baseClass} hover:border-accent`}
        style={{
          borderColor: "var(--line)",
          color: "var(--muted)",
        }}
      >
        <span className="truncate">{label}</span>
      </Link>
    );
    return (
      <span className="inline-flex items-center gap-1">
        {link}
        <AddToPeerSetButton
          companyId={peer.company_id}
          ticker={peer.ticker}
          name={peer.display_name}
          importable={!peer.in_db}
          variant="icon"
        />
      </span>
    );
  }
  // Couldn't resolve — render as plain text so the analyst still sees
  // the name from the filing.
  return (
    <span
      className={baseClass}
      title="No SEC ticker match for this peer name."
      style={{
        borderColor: "var(--line)",
        color: "var(--muted)",
        cursor: "default",
      }}
    >
      <span className="truncate">{peer.display_name}</span>
    </span>
  );
}
