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
});
