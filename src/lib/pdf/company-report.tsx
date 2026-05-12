/* @jsxImportSource react */
/**
 * Per-company analyst PDF report. Multi-page layout:
 *   Page 1 — Summary header, latest filing metadata, headline facts
 *   Page 2 — Executive compensation table (SCT)
 *   Page 3 — Pay mix breakdown + YoY pay delta + source citations
 *
 * Rendered server-side with @react-pdf/renderer; emits a Buffer the
 * Next.js route streams back as application/pdf. The renderer doesn't
 * support web fonts on Vercel out of the box without registering them
 * explicitly, so we stick to the built-in Helvetica family for
 * portability.
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import type {
  CompanyRow,
  FilingDetail,
  PolicyFactRow,
  MetricFactRow,
  ExecutiveCompRow,
} from "@/lib/types";
import {
  factSourceLabel,
  factSourceTooltip,
} from "@/lib/extractors/fact-source";

interface PeerColumn {
  ticker: string;
  ceoTotal: string;
  payRatio: string;
}

export interface CompanyReportProps {
  company: CompanyRow;
  latest: FilingDetail;
  prior: FilingDetail | null;
  peers: PeerColumn[]; // optional small peer row; can be empty
  generatedAt: Date;
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 50,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#1a1a1a",
    lineHeight: 1.4,
  },
  kicker: {
    fontSize: 8,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#7a5b3a",
    marginBottom: 6,
  },
  h1: { fontSize: 22, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  h2: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 20, marginBottom: 8 },
  h3: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 12, marginBottom: 4 },
  meta: { fontSize: 9, color: "#6c6c6c", marginBottom: 12 },
  statGrid: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 0, marginTop: 8 },
  statCell: {
    width: "50%",
    paddingRight: 8,
    paddingBottom: 12,
  },
  statLabel: {
    fontSize: 8,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "#7a5b3a",
  },
  statBadge: {
    fontSize: 7,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "#6c6c6c",
    borderWidth: 0.5,
    borderColor: "#c8c0b3",
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 4,
  },
  statRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  statValue: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 2 },
  statHint: { fontSize: 8, color: "#6c6c6c", marginTop: 2 },
  table: { marginTop: 8, borderTopWidth: 0.5, borderColor: "#c8c0b3" },
  thead: {
    flexDirection: "row",
    backgroundColor: "#f5f0e8",
    borderBottomWidth: 0.5,
    borderColor: "#c8c0b3",
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  th: { fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", color: "#5a4630" },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.3,
    borderColor: "#e6e0d4",
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  td: { fontSize: 8 },
  citation: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 0.3,
    borderColor: "#e6e0d4",
  },
  citationLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: "#3a2c1b",
  },
  citationExcerpt: {
    fontSize: 8,
    color: "#3a3a3a",
    fontStyle: "italic",
    marginTop: 2,
  },
  citationMeta: { fontSize: 7, color: "#6c6c6c", marginTop: 2 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#9b8c75",
  },
});

function formatTotal(v: string | null | undefined): string {
  if (!v) return "—";
  return v.startsWith("$") ? v : `$${v}`;
}

function findMetric(filing: FilingDetail, normalized: string): MetricFactRow | undefined {
  return filing.metrics.find((m) => m.metric_name_normalized === normalized);
}
function findPolicy(filing: FilingDetail, type: string): PolicyFactRow | undefined {
  return filing.policies.find((p) => p.policy_type === type);
}

function ceoRow(filing: FilingDetail): ExecutiveCompRow | undefined {
  const latestYear = filing.executive_compensation.length
    ? Math.max(...filing.executive_compensation.map((r) => r.year))
    : null;
  if (latestYear === null) return undefined;
  return filing.executive_compensation.find(
    (r) =>
      r.year === latestYear &&
      /\bexecutive\s+officer\b/i.test(r.principal_position ?? ""),
  );
}

function magnitude(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function payMix(r: ExecutiveCompRow | undefined) {
  if (!r) return null;
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

function yoyDelta(current?: string | null, prior?: string | null) {
  const a = magnitude(current);
  const b = magnitude(prior);
  if (a == null || b == null || b === 0) return null;
  const pct = ((a - b) / b) * 100;
  if (!Number.isFinite(pct)) return null;
  return { pct: Math.round(pct), direction: pct > 1 ? "up" : pct < -1 ? "down" : "flat" };
}

function StatCell({
  label,
  value,
  badge,
  hint,
}: {
  label: string;
  value: string;
  badge?: string;
  hint?: string;
}) {
  return (
    <View style={styles.statCell}>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>{label}</Text>
        {badge ? <Text style={styles.statBadge}>{badge}</Text> : null}
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export function CompanyReport({ company, latest, prior, peers, generatedAt }: CompanyReportProps) {
  const ceo = ceoRow(latest);
  const priorCeo = prior ? ceoRow(prior) : undefined;
  const ceoDelta = yoyDelta(ceo?.total, priorCeo?.total);
  const mix = payMix(ceo);
  const payRatio = findMetric(latest, "ceo_pay_ratio");
  const medianEmp = findMetric(latest, "median_employee_compensation");
  const sayOnPay = findMetric(latest, "say_on_pay");
  const compCommittee = findPolicy(latest, "compensation_committee");
  const clawback = findPolicy(latest, "clawback");
  const hedging = findPolicy(latest, "hedging");
  const pledging = findPolicy(latest, "pledging");
  const ownership = findPolicy(latest, "stock_ownership_guidelines");

  const headerMeta = `${latest.filing_year} ${latest.form_type ?? "DEF 14A"} · filed ${
    latest.filing_date ? new Date(latest.filing_date).toISOString().slice(0, 10) : "—"
  } · CIK ${company.cik}`;

  // Executive comp rows — show the latest disclosed year.
  const latestYear = latest.executive_compensation.length
    ? Math.max(...latest.executive_compensation.map((r) => r.year))
    : null;
  const rows = latestYear === null
    ? []
    : latest.executive_compensation
        .filter((r) => r.year === latestYear)
        .sort((a, b) => (magnitude(b.total) ?? 0) - (magnitude(a.total) ?? 0))
        .slice(0, 6);

  return (
    <Document
      title={`${company.name} ${latest.filing_year} ProxyMiner Report`}
      author="ProxyMiner"
    >
      {/* PAGE 1 — summary */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.kicker}>ProxyMiner · Analyst Pack</Text>
        <Text style={styles.h1}>
          {company.name}
          {company.ticker ? `  (${company.ticker})` : ""}
        </Text>
        <Text style={styles.meta}>{headerMeta}</Text>

        <Text style={styles.h2}>Headline facts</Text>
        <View style={styles.statGrid}>
          <StatCell
            label="CEO total pay"
            value={ceo ? formatTotal(ceo.total) : "—"}
            hint={ceo ? `${ceo.executive_name} · ${ceo.year}${ceoDelta ? ` · ${ceoDelta.direction === "up" ? "↑" : ceoDelta.direction === "down" ? "↓" : "→"} ${Math.abs(ceoDelta.pct)}% YoY` : ""}` : "Not extracted"}
          />
          <StatCell
            label="Say on pay"
            value={sayOnPay?.observed_value ?? "Not disclosed"}
            badge={sayOnPay ? factSourceLabel(sayOnPay.extraction_method) : undefined}
            hint={sayOnPay ? factSourceTooltip(sayOnPay.extraction_method) : undefined}
          />
          <StatCell
            label="CEO pay ratio"
            value={payRatio?.observed_value ?? "Not in CD&A"}
            badge={payRatio ? factSourceLabel(payRatio.extraction_method) : undefined}
            hint={
              medianEmp?.observed_value
                ? `Median employee: ${medianEmp.observed_value}`
                : undefined
            }
          />
          <StatCell
            label="Compensation committee"
            value={compCommittee?.normalized_value ?? "Not extracted"}
            badge={compCommittee ? factSourceLabel(compCommittee.extraction_method) : undefined}
          />
        </View>

        <Text style={styles.h2}>Governance policies</Text>
        <View style={styles.statGrid}>
          <StatCell
            label="Clawback"
            value={clawback?.normalized_value ?? "Not extracted"}
          />
          <StatCell
            label="Hedging"
            value={hedging?.normalized_value ?? "Not disclosed"}
          />
          <StatCell
            label="Pledging"
            value={pledging?.normalized_value ?? "Not disclosed"}
          />
          <StatCell
            label="Stock ownership guidelines"
            value={ownership?.normalized_value ?? "Not extracted"}
          />
        </View>

        {peers.length > 0 ? (
          <>
            <Text style={styles.h2}>Peer snapshot</Text>
            <View style={styles.table}>
              <View style={styles.thead}>
                <View style={{ flex: 1 }}><Text style={styles.th}>Ticker</Text></View>
                <View style={{ flex: 2 }}><Text style={styles.th}>CEO total</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.th}>Pay ratio</Text></View>
              </View>
              {peers.map((p) => (
                <View key={p.ticker} style={styles.tr}>
                  <View style={{ flex: 1 }}><Text style={styles.td}>{p.ticker}</Text></View>
                  <View style={{ flex: 2 }}><Text style={styles.td}>{p.ceoTotal}</Text></View>
                  <View style={{ flex: 1 }}><Text style={styles.td}>{p.payRatio}</Text></View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>ProxyMiner · {company.ticker?.toUpperCase() ?? company.id.toUpperCase()}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>

      {/* PAGE 2 — executive compensation table */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.kicker}>Executive Compensation</Text>
        <Text style={styles.h2}>Summary Compensation Table (latest disclosed year)</Text>
        <Text style={styles.meta}>
          {latestYear !== null ? `Year ${latestYear}` : "No SCT rows extracted from this filing."}
        </Text>
        {rows.length > 0 ? (
          <View style={styles.table}>
            <View style={styles.thead}>
              <View style={{ flex: 2.5 }}><Text style={styles.th}>Executive</Text></View>
              <View style={{ flex: 1.7 }}><Text style={styles.th}>Salary</Text></View>
              <View style={{ flex: 1.7 }}><Text style={styles.th}>Stock</Text></View>
              <View style={{ flex: 1.7 }}><Text style={styles.th}>Cash incentive</Text></View>
              <View style={{ flex: 1.7 }}><Text style={styles.th}>Other</Text></View>
              <View style={{ flex: 1.7 }}><Text style={styles.th}>Total</Text></View>
            </View>
            {rows.map((r) => (
              <View key={`${r.executive_name}-${r.year}`} style={styles.tr}>
                <View style={{ flex: 2.5 }}>
                  <Text style={styles.td}>{r.executive_name}</Text>
                  <Text style={[styles.td, { color: "#6c6c6c", fontSize: 7 }]}>
                    {r.principal_position ?? "Named executive officer"}
                  </Text>
                </View>
                <View style={{ flex: 1.7 }}><Text style={styles.td}>{formatTotal(r.salary)}</Text></View>
                <View style={{ flex: 1.7 }}><Text style={styles.td}>{formatTotal(r.stock_awards)}</Text></View>
                <View style={{ flex: 1.7 }}><Text style={styles.td}>{formatTotal(r.non_equity_incentive_plan_compensation)}</Text></View>
                <View style={{ flex: 1.7 }}><Text style={styles.td}>{formatTotal(r.all_other_compensation)}</Text></View>
                <View style={{ flex: 1.7 }}><Text style={[styles.td, { fontFamily: "Helvetica-Bold" }]}>{formatTotal(r.total)}</Text></View>
              </View>
            ))}
          </View>
        ) : null}

        {mix ? (
          <>
            <Text style={styles.h2}>CEO pay mix (latest year)</Text>
            <View style={styles.table}>
              <View style={styles.tr}>
                <View style={{ flex: 1 }}><Text style={styles.td}>Base salary</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.td}>{mix.basePct}%</Text></View>
              </View>
              <View style={styles.tr}>
                <View style={{ flex: 1 }}><Text style={styles.td}>Cash incentive</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.td}>{mix.bonusPct}%</Text></View>
              </View>
              <View style={styles.tr}>
                <View style={{ flex: 1 }}><Text style={styles.td}>Equity</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.td}>{mix.equityPct}%</Text></View>
              </View>
              <View style={styles.tr}>
                <View style={{ flex: 1 }}><Text style={styles.td}>Other</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.td}>{mix.otherPct}%</Text></View>
              </View>
              <View style={[styles.tr, { backgroundColor: "#f5f0e8" }]}>
                <View style={{ flex: 1 }}><Text style={[styles.td, { fontFamily: "Helvetica-Bold" }]}>At-risk</Text></View>
                <View style={{ flex: 1 }}><Text style={[styles.td, { fontFamily: "Helvetica-Bold" }]}>{mix.atRiskPct}%</Text></View>
              </View>
            </View>
          </>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>ProxyMiner · {company.ticker?.toUpperCase() ?? company.id.toUpperCase()}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>

      {/* PAGE 3 — source citations */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.kicker}>Source Citations</Text>
        <Text style={styles.h2}>Every fact above, traced back to filing text</Text>
        <Text style={styles.meta}>
          Generated {generatedAt.toISOString().slice(0, 19).replace("T", " ")}Z.
          Each citation lists the section the fact was extracted from
          (CD&A, Item 402(u), Item 407(e)(5) committee report).
        </Text>

        {[
          { label: "CEO pay ratio", fact: payRatio },
          { label: "Median employee compensation", fact: medianEmp },
          { label: "Say on pay", fact: sayOnPay },
        ].map(({ label, fact }) =>
          fact ? (
            <View key={label} style={styles.citation}>
              <Text style={styles.citationLabel}>
                {label} = {fact.observed_value ?? "—"}
              </Text>
              <Text style={styles.citationMeta}>
                {factSourceTooltip(fact.extraction_method)} · confidence{" "}
                {fact.confidence_score ?? "n/a"}
              </Text>
              <Text style={styles.citationExcerpt}>
                &ldquo;{(fact.source_excerpt ?? "").slice(0, 600)}{
                  (fact.source_excerpt ?? "").length > 600 ? "…" : ""
                }&rdquo;
              </Text>
            </View>
          ) : null,
        )}

        {[
          { label: "Compensation committee", fact: compCommittee },
          { label: "Clawback policy", fact: clawback },
          { label: "Hedging policy", fact: hedging },
          { label: "Pledging policy", fact: pledging },
          { label: "Stock ownership guidelines", fact: ownership },
        ].map(({ label, fact }) =>
          fact ? (
            <View key={label} style={styles.citation}>
              <Text style={styles.citationLabel}>
                {label} = {fact.normalized_value ?? "—"}
              </Text>
              <Text style={styles.citationMeta}>
                {factSourceTooltip(fact.extraction_method)} · confidence{" "}
                {fact.confidence_score ?? "n/a"}
              </Text>
              <Text style={styles.citationExcerpt}>
                &ldquo;{(fact.source_excerpt ?? "").slice(0, 600)}{
                  (fact.source_excerpt ?? "").length > 600 ? "…" : ""
                }&rdquo;
              </Text>
            </View>
          ) : null,
        )}

        <View style={styles.footer} fixed>
          <Text>ProxyMiner · {company.ticker?.toUpperCase() ?? company.id.toUpperCase()}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
