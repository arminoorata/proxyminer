/**
 * Year-over-year CD&A diff route. Picks two filings for the same
 * company and shows what changed across the canonical comp-analyst
 * axes: peer groups (members added/removed), policies, performance
 * metrics, NEO compensation, CD&A prose similarity.
 *
 *   /company/aapl/diff?from=<filingId>&to=<filingId>
 *
 * If the from/to params are missing, default to the two most-recent
 * filings (newest = to, second-newest = from). Nothing is invented;
 * cells that the deterministic extractor didn't find say "Not
 * extracted" with a hint to use Ask on the source filing.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import DiffFilingPicker from "@/components/DiffFilingPicker";
import {
  diffExecutives,
  diffMetrics,
  diffPeerGroups,
  diffPolicies,
  diffSections,
  summarizeDiff,
  type ExecChange,
  type MetricChange,
  type PeerGroupChange,
  type PolicyChange,
  type SectionDiff,
} from "@/lib/diff/cda-diff";
import {
  getCompany,
  getFilingDetail,
  listFilings,
} from "@/lib/data/source";
import type { FilingDetail, FilingRow } from "@/lib/types";

function fmtCurrency(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtSignedCurrency(v: number | null): string {
  if (v === null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${fmtCurrency(v)}`;
}

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function statusTone(status: string): { color: string; label: string } {
  switch (status) {
    case "added":
      return { color: "var(--accent-strong)", label: "Added" };
    case "removed":
      return { color: "#ef4444", label: "Removed" };
    case "changed":
      return { color: "#f59e0b", label: "Changed" };
    default:
      return { color: "var(--muted)", label: "Unchanged" };
  }
}

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companyId } = await params;
  const sp = await searchParams;

  const company = await getCompany(companyId);
  if (!company) notFound();

  const filings = await listFilings(companyId);
  if (filings.length < 2) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12 md:px-10">
        <header>
          <p
            className="text-xs font-medium uppercase tracking-[0.32em]"
            style={{ color: "var(--accent)" }}
          >
            ProxyMiner / Diff
          </p>
          <h1 className="mt-3 text-3xl font-semibold">{company.name}</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            We need at least two filings on file to run a year-over-year diff.{" "}
            {filings.length === 0
              ? "No filings have been ingested for this company yet."
              : "Only one filing is currently ingested."}
          </p>
          <Link
            href={`/company/${companyId}`}
            className="mt-4 inline-block text-xs uppercase tracking-[0.16em] hover:underline"
          >
            ← Back to {company.name}
          </Link>
        </header>
      </main>
    );
  }

  // Resolve the two filings to compare. Either explicit ids in the
  // query or the most-recent two by filing_date.
  const fromId = typeof sp.from === "string" ? sp.from : null;
  const toId = typeof sp.to === "string" ? sp.to : null;
  const defaultTo = filings[0];
  const defaultFrom = filings[1] ?? filings[0];
  const toFiling: FilingRow | null =
    filings.find((f) => f.id === toId) ?? defaultTo ?? null;
  const fromFiling: FilingRow | null =
    filings.find((f) => f.id === fromId && f.id !== toFiling?.id) ?? defaultFrom ?? null;
  if (!toFiling || !fromFiling) notFound();

  const [fromDetail, toDetail] = await Promise.all([
    getFilingDetail(fromFiling.id),
    getFilingDetail(toFiling.id),
  ]);
  if (!fromDetail || !toDetail) notFound();

  // The from-filing should always be older. If params accidentally
  // flipped them, swap so deltas read intuitively.
  const flipped = (fromDetail.filing_date ?? "") > (toDetail.filing_date ?? "");
  const olderDetail = flipped ? toDetail : fromDetail;
  const newerDetail = flipped ? fromDetail : toDetail;

  const peerChanges = diffPeerGroups(olderDetail.peer_groups, newerDetail.peer_groups);
  const policyChanges = diffPolicies(olderDetail.policies, newerDetail.policies);
  const metricChanges = diffMetrics(olderDetail.metrics, newerDetail.metrics);
  const execChanges = diffExecutives(
    olderDetail.executive_compensation,
    newerDetail.executive_compensation,
  );
  const sectionChanges = diffSections(olderDetail, newerDetail);
  const summary = summarizeDiff({ peerChanges, policyChanges, metricChanges, execChanges });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p
            className="text-xs font-medium uppercase tracking-[0.32em]"
            style={{ color: "var(--accent)" }}
          >
            ProxyMiner / Diff
          </p>
          <h1 className="mt-3 text-3xl font-semibold md:text-4xl">
            {company.name}{" "}
            <span className="font-mono text-base" style={{ color: "var(--muted)" }}>
              {company.ticker ?? company.id.toUpperCase()}
            </span>
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Comparing the {olderDetail.filing_year} proxy against the {newerDetail.filing_year} proxy.
          </p>
        </div>
        <Link
          href={`/company/${companyId}`}
          className="text-xs uppercase tracking-[0.16em] hover:underline"
        >
          ← Back to {company.name}
        </Link>
      </header>

      <section className="mt-8">
        <DiffFilingPicker
          filings={filings}
          fromId={olderDetail.id}
          toId={newerDetail.id}
          companyId={companyId}
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="CEO total Δ">
          <strong className="text-2xl">{fmtSignedCurrency(summary.ceoTotalDelta)}</strong>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {summary.ceoTotalDeltaPct === null
              ? "No prior-year CEO total to compare"
              : `${fmtPct(summary.ceoTotalDeltaPct)} year-over-year`}
          </p>
        </Stat>
        <Stat label="Peer churn">
          <strong className="text-2xl">
            {summary.peerAdded > 0 ? `+${summary.peerAdded} ` : ""}
            {summary.peerRemoved > 0 ? `−${summary.peerRemoved}` : ""}
            {summary.peerAdded + summary.peerRemoved === 0 ? "0" : ""}
          </strong>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Members added or dropped across all peer groups
          </p>
        </Stat>
        <Stat label="Policy + metric churn">
          <strong className="text-2xl">
            {summary.policiesChanged + summary.policiesAdded + summary.policiesRemoved + summary.metricsChanged + summary.metricsAdded + summary.metricsRemoved}
          </strong>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Disclosures whose value moved or appeared/disappeared
          </p>
        </Stat>
      </section>

      <PeerGroupSection changes={peerChanges} />
      <ExecutiveSection changes={execChanges} />
      <PolicySection changes={policyChanges} />
      <MetricSection changes={metricChanges} />
      <CdaSection changes={sectionChanges} oldDetail={olderDetail} newDetail={newerDetail} />

      <p className="mt-12 text-xs italic" style={{ color: "var(--muted)" }}>
        Cells reading &ldquo;Not extracted&rdquo; mean the deterministic extractor didn&rsquo;t pick
        up that disclosure for the listed filing — not that it isn&rsquo;t in the proxy. Open the
        company workspace and use Ask to query the CD&amp;A directly.
      </p>
    </main>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <p
        className="text-[11px] font-medium uppercase tracking-[0.18em]"
        style={{ color: "var(--accent)" }}
      >
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SectionHeader({ kicker, title, hint }: { kicker: string; title: string; hint?: string }) {
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

function PeerGroupSection({ changes }: { changes: PeerGroupChange[] }) {
  if (changes.length === 0) {
    return (
      <section className="mt-12">
        <SectionHeader
          kicker="Peer groups"
          title="Peer disclosure"
          hint="No peer groups were extracted from either filing."
        />
      </section>
    );
  }
  return (
    <section className="mt-12">
      <SectionHeader kicker="Peer groups" title="Peer disclosure" />
      <ul className="mt-6 grid grid-cols-1 gap-4">
        {changes.map((g, i) => (
          <li
            key={i}
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{g.peer_group_name}</p>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--muted)" }}>
                  {g.peer_group_type ?? "—"} · {g.fromMembers} → {g.toMembers} members
                </p>
              </div>
              <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                {g.kept} kept · +{g.added.length} · −{g.removed.length}
              </p>
            </div>
            {g.added.length > 0 ? (
              <div className="mt-3">
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "var(--accent-strong)" }}
                >
                  Added
                </p>
                <p className="mt-1 text-xs leading-relaxed">
                  {g.added.map((m) => (m.ticker ? `${m.name} (${m.ticker})` : m.name)).join(" · ")}
                </p>
              </div>
            ) : null}
            {g.removed.length > 0 ? (
              <div className="mt-3">
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "#ef4444" }}
                >
                  Removed
                </p>
                <p className="mt-1 text-xs leading-relaxed">
                  {g.removed.map((m) => (m.ticker ? `${m.name} (${m.ticker})` : m.name)).join(" · ")}
                </p>
              </div>
            ) : null}
            {g.added.length === 0 && g.removed.length === 0 ? (
              <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                Same membership year-over-year.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExecutiveSection({ changes }: { changes: ExecChange[] }) {
  if (changes.length === 0) {
    return (
      <section className="mt-12">
        <SectionHeader
          kicker="Executive pay"
          title="Named executive compensation"
          hint="No SCT rows extracted from either filing."
        />
      </section>
    );
  }
  return (
    <section className="mt-12">
      <SectionHeader kicker="Executive pay" title="Named executive compensation" />
      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left">
              <Th>Executive</Th>
              <Th>Status</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Δ Total</Th>
              <Th>Δ %</Th>
              <Th>Δ At-risk</Th>
            </tr>
          </thead>
          <tbody>
            {changes.map((e, i) => {
              const tone = statusTone(e.status);
              const atRiskDelta =
                e.fromMix && e.toMix ? e.toMix.atRiskPct - e.fromMix.atRiskPct : null;
              return (
                <tr key={i} className="border-t" style={{ borderColor: "var(--line)" }}>
                  <Td>
                    <div className="flex flex-col">
                      <strong>{e.executive_name}</strong>
                      <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {e.principal_position ?? "Named executive"}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <span
                      className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]"
                      style={{ borderColor: tone.color, color: tone.color }}
                    >
                      {tone.label}
                    </span>
                    {e.isCEO ? (
                      <span
                        className="ml-2 text-[10px] uppercase tracking-[0.16em]"
                        style={{ color: "var(--accent)" }}
                      >
                        CEO
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {e.fromTotal !== null ? fmtCurrency(e.fromTotal) : "—"}
                    {e.fromYear !== null ? (
                      <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {e.fromYear}
                      </p>
                    ) : null}
                  </Td>
                  <Td>
                    {e.toTotal !== null ? fmtCurrency(e.toTotal) : "—"}
                    {e.toYear !== null ? (
                      <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {e.toYear}
                      </p>
                    ) : null}
                  </Td>
                  <Td>{fmtSignedCurrency(e.totalDelta)}</Td>
                  <Td>{fmtPct(e.totalDeltaPct)}</Td>
                  <Td>{atRiskDelta === null ? "—" : `${atRiskDelta > 0 ? "+" : ""}${atRiskDelta.toFixed(1)} pp`}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicySection({ changes }: { changes: PolicyChange[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="mt-12">
      <SectionHeader kicker="Governance" title="Policy guardrails" />
      <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {changes.map((p, i) => {
          const tone = statusTone(p.status);
          return (
            <li
              key={i}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "var(--accent)" }}
                >
                  {p.policy_type.replace(/_/g, " ")}
                </p>
                <span
                  className="text-[10px] uppercase tracking-[0.16em]"
                  style={{ color: tone.color }}
                >
                  {tone.label}
                </span>
              </div>
              <p className="mt-1 text-sm">
                <span style={{ color: "var(--muted)" }}>{p.fromValue ?? "Not extracted"}</span>{" "}
                <span style={{ color: "var(--muted)" }}>→</span>{" "}
                <strong style={{ color: "var(--text)" }}>{p.toValue ?? "Not extracted"}</strong>
              </p>
              {p.toExcerpt ? (
                <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  &ldquo;{p.toExcerpt.slice(0, 220)}
                  {p.toExcerpt.length > 220 ? "…" : ""}&rdquo;
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MetricSection({ changes }: { changes: MetricChange[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="mt-12">
      <SectionHeader kicker="Performance markers" title="Metric facts" />
      <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {changes.map((m, i) => {
          const tone = statusTone(m.status);
          return (
            <li
              key={i}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "var(--accent)" }}
                >
                  {(m.metric_name_normalized).replace(/_/g, " ")}
                </p>
                <span
                  className="text-[10px] uppercase tracking-[0.16em]"
                  style={{ color: tone.color }}
                >
                  {tone.label}
                </span>
              </div>
              <p className="mt-1 text-sm">
                <span style={{ color: "var(--muted)" }}>{m.fromValue ?? "Not extracted"}</span>{" "}
                <span style={{ color: "var(--muted)" }}>→</span>{" "}
                <strong style={{ color: "var(--text)" }}>{m.toValue ?? "Not extracted"}</strong>
              </p>
              {m.numericDelta !== null ? (
                <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                  Numeric delta: {m.numericDelta > 0 ? "+" : ""}
                  {m.numericDelta.toFixed(2)}
                </p>
              ) : null}
              {m.toExcerpt ? (
                <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  &ldquo;{m.toExcerpt.slice(0, 220)}
                  {m.toExcerpt.length > 220 ? "…" : ""}&rdquo;
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CdaSection({
  changes,
  oldDetail,
  newDetail,
}: {
  changes: SectionDiff[];
  oldDetail: FilingDetail;
  newDetail: FilingDetail;
}) {
  const cda = changes.find((c) => c.section_type === "cd_and_a");
  if (!cda) return null;
  // Show similarity for any non-CD&A sections we captured for both
  // filings, so analysts can see whether the pay-ratio disclosure or
  // committee report moved year-over-year — not just CD&A.
  const SECTION_LABELS: Record<string, string> = {
    ceo_pay_ratio: "Pay Ratio (Item 402(u))",
    say_on_pay: "Say-on-Pay proposal",
    compensation_committee_report: "Committee Report",
  };
  const extraSections = changes
    .filter(
      (c) =>
        c.section_type !== "cd_and_a" &&
        c.fromLength > 0 &&
        c.toLength > 0 &&
        SECTION_LABELS[c.section_type],
    )
    .sort((a, b) => (SECTION_LABELS[a.section_type] ?? "").localeCompare(SECTION_LABELS[b.section_type] ?? ""));
  return (
    <section className="mt-12">
      <SectionHeader
        kicker="Narrative"
        title="CD&amp;A prose similarity"
        hint="Coarse measure of how much the compensation discussion text moved year-over-year. Not a substitute for reading the actual filings."
      />
      <div
        className="mt-6 rounded-lg border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <p className="text-sm">
          <strong>{cda.similarityPct}%</strong> shingled-prose overlap between the two filings.
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          {oldDetail.filing_year}: {cda.fromLength.toLocaleString()} chars ·{" "}
          {newDetail.filing_year}: {cda.toLength.toLocaleString()} chars
        </p>
        {extraSections.length > 0 ? (
          <ul className="mt-4 space-y-1 text-[12px]" style={{ color: "var(--muted)" }}>
            {extraSections.map((s) => (
              <li key={s.section_type} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium" style={{ color: "var(--text)" }}>
                  {SECTION_LABELS[s.section_type]}:
                </span>
                <span>
                  <strong style={{ color: "var(--text)" }}>{s.similarityPct}%</strong> overlap (
                  {s.fromLength.toLocaleString()} → {s.toLength.toLocaleString()} chars)
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {oldDetail.primary_document_url ? (
            <a
              href={oldDetail.primary_document_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] uppercase tracking-[0.16em] hover:underline"
              style={{ color: "var(--accent)" }}
            >
              {oldDetail.filing_year} proxy on SEC ↗
            </a>
          ) : null}
          {newDetail.primary_document_url ? (
            <a
              href={newDetail.primary_document_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] uppercase tracking-[0.16em] hover:underline"
              style={{ color: "var(--accent)" }}
            >
              {newDetail.filing_year} proxy on SEC ↗
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="border-b px-3 py-2 text-left text-[11px] uppercase tracking-[0.16em]"
      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3 py-2.5 align-top text-[13px]" style={{ color: "var(--text)" }}>
      {children}
    </td>
  );
}
