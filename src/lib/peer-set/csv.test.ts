/**
 * CSV shape pinning. The exporter is what an analyst sends to a comp
 * committee — silently dropping or reordering columns is a real harm.
 */
import { describe, expect, it } from "vitest";

import { type ColumnPayload, notIngestedPayload } from "./csv-payload";
import { buildPeerSetCsv } from "./csv";

function aapl(): ColumnPayload {
  return {
    companyId: "aapl",
    companyName: "Apple Inc.",
    ticker: "AAPL",
    filingYear: 2025,
    filingUrl: "https://example.test/aapl.htm",
    ceoName: "Tim Cook",
    ceoTotal: 74600000,
    ceoYear: 2024,
    neoCount: 5,
    primaryPeers: 22,
    policies: {
      hedging: "Prohibited",
      pledging: "Prohibited",
      clawback: "Mandatory recovery",
      stockOwnership: "10x base salary CEO",
      changeInControl: "Double-trigger",
      compConsultant: "Semler Brossy",
      compCommittee: "Compensation Committee",
    },
    metrics: {
      sayOnPay: "97%",
      relativeTsr: "Top quartile",
      revenue: "$391B",
      operatingIncome: "$123B",
      annualIncentive: "100% of target",
      rsuVesting: "100%",
      performanceMix: "60%",
      timeMix: "40%",
      ceoPayRatio: "672:1",
      medianEmployeeComp: "$70,200",
    },
    payMix: { base: 3000000, bonus: 12000000, equity: 58000000, other: 1600000, total: 74600000 },
    notIngested: false,
  };
}

describe("buildPeerSetCsv", () => {
  it("emits header + every documented row in order", () => {
    const csv = buildPeerSetCsv([aapl()]);
    const lines = csv.split("\n");
    // Pin the leading header and a handful of fixed-position rows.
    expect(lines[0]).toBe("Axis,Apple Inc. (AAPL)");
    expect(lines[1]).toBe("Filing year,2025");
    expect(lines[2]).toBe("Filing URL,https://example.test/aapl.htm");
    expect(lines[3]).toBe("In ProxyMiner DB,yes");
    // Section dividers are present.
    expect(csv).toContain("— Executive pay —");
    expect(csv).toContain("— Peer disclosure —");
    expect(csv).toContain("— Pay ratio (Item 402(u)) —");
    expect(csv).toContain("— Performance metrics —");
    expect(csv).toContain("— Governance —");
  });

  it("renders pay-mix percentages from numbers", () => {
    const csv = buildPeerSetCsv([aapl()]);
    expect(csv).toContain("CEO base %,4%");        // 3M / 74.6M ≈ 4%
    expect(csv).toContain("CEO cash incentive %,16%");
    expect(csv).toContain("CEO equity %,78%");
    expect(csv).toContain("CEO at-risk %,94%");    // bonus + equity
  });

  it("emits blank pay-mix when payMix is null", () => {
    const c = { ...aapl(), payMix: null };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain("CEO base %,");
    expect(csv).toContain("CEO at-risk %,");
  });

  it("quotes cells containing commas or quotes", () => {
    const c = {
      ...aapl(),
      policies: { ...aapl().policies, clawback: 'Recovery, "no-fault"' },
    };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain('Clawback,"Recovery, ""no-fault"""');
  });

  it("marks not-ingested rows as 'no'", () => {
    const csv = buildPeerSetCsv([notIngestedPayload("zzzz")]);
    expect(csv).toContain("In ProxyMiner DB,no");
    expect(csv).toContain("Filing year,");      // blank
    expect(csv).toContain("CEO total,");        // blank
  });

  it("handles multiple companies side by side", () => {
    const csv = buildPeerSetCsv([aapl(), notIngestedPayload("zzzz")]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Axis,Apple Inc. (AAPL),ZZZZ (ZZZZ)");
    expect(lines[3]).toBe("In ProxyMiner DB,yes,no");
  });

  it("guards against CSV formula injection on each risky char", () => {
    // Each Excel-formula-trigger char (`=`, `+`, `-`, `@`, tab, CR)
    // must be prefixed with `'` in the output.
    const evil = (s: string) => ({
      ...aapl(),
      policies: { ...aapl().policies, clawback: s },
    });
    expect(buildPeerSetCsv([evil("=HYPERLINK(\"http://x\")")])).toContain(
      `Clawback,"'=HYPERLINK(""http://x"")"`,
    );
    expect(buildPeerSetCsv([evil("+1+2")])).toContain("Clawback,'+1+2");
    expect(buildPeerSetCsv([evil("-5")])).toContain("Clawback,'-5");
    expect(buildPeerSetCsv([evil("@SUM(A1)")])).toContain("Clawback,'@SUM(A1)");
    // Safe content stays unchanged.
    expect(buildPeerSetCsv([evil("Mandatory recovery")])).toContain(
      "Clawback,Mandatory recovery",
    );
  });

  it("numbers are not formula-guarded (they're not strings)", () => {
    const c = { ...aapl(), ceoTotal: -5 };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain("CEO total,-5");
  });

  // ── Phase 28 edge cases ────────────────────────────────────────────
  // Pin behaviors that an analyst could trip while loading the export
  // into Excel/Sheets/pandas. Each scenario corresponds to a way the
  // upstream payload can be partially missing in practice (NEO row
  // without a year, policy text the extractor copied verbatim from a
  // multi-line bullet, ticker with no company name, etc.).

  it("null filingUrl emits a blank cell (not 'null')", () => {
    // Phase 28: per-company try/catch in /api/peerset/export can
    // return a payload with filingUrl=null when the latest filing
    // resolution failed. The CSV must render that as empty, not the
    // string "null".
    const c = { ...aapl(), filingUrl: null };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain("Filing URL,\n");
    expect(csv).not.toContain("Filing URL,null");
  });

  it("multi-line policy text is wrapped in quotes and preserved verbatim", () => {
    // Phase 28: the extractor occasionally lifts a policy out of a
    // multi-line HTML bullet. The CSV must wrap such cells in quotes
    // so the newline doesn't terminate the row early — otherwise the
    // analyst's spreadsheet would split one row into two.
    const c = {
      ...aapl(),
      policies: {
        ...aapl().policies,
        clawback: "Recovery on financial restatement.\nFraud-based forfeiture.",
      },
    };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain(
      'Clawback,"Recovery on financial restatement.\nFraud-based forfeiture."',
    );
  });

  it("ticker null in a payload still renders a header without the (TICKER) suffix", () => {
    // Phase 28: companies.ticker is nullable. The header builder
    // should NOT emit `Apple Inc. (null)` or `Apple Inc. ()`.
    const c = { ...aapl(), ticker: null };
    const csv = buildPeerSetCsv([c]);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe("Axis,Apple Inc.");
    expect(firstLine).not.toContain("null");
    expect(firstLine).not.toContain("()");
  });

  it("empty payload list emits headers only", () => {
    // Phase 28: never seen in practice but defensible — caller passed
    // an empty company list. The result should still parse as a
    // single-column CSV with the Axis labels.
    const csv = buildPeerSetCsv([]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Axis");
    expect(lines[1]).toBe("Filing year");
    // Section dividers still render.
    expect(csv).toContain("— Executive pay —");
  });

  it("payMix with total=0 emits blank pay-mix cells (no NaN%)", () => {
    // Phase 28: ceoPayMix() returns null on total<=0, but if a hand-
    // built payload ever passes total=0 directly, pct() must not
    // emit "NaN%" — it should render blank.
    const c = {
      ...aapl(),
      payMix: { base: 0, bonus: 0, equity: 0, other: 0, total: 0 },
    };
    const csv = buildPeerSetCsv([c]);
    expect(csv).toContain("CEO base %,\n");
    expect(csv).not.toMatch(/NaN%/);
  });
});
