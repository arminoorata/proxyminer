import { describe, expect, it } from "vitest";

import type {
  ExecutiveCompRow,
  MetricFactRow,
  PeerGroupRow,
  PolicyFactRow,
} from "@/lib/types";

import {
  diffExecutives,
  diffMetrics,
  diffPeerGroups,
  diffPolicies,
  magnitude,
  sectionSimilarity,
  summarizeDiff,
} from "./cda-diff";

const provenance = {
  extractor_version: "test",
  extraction_method: "test",
  source_document_name: null,
  source_document_sha: null,
  verification_status: "machine_extracted" as const,
  review_status: "unreviewed" as const,
  reviewed_by: null,
  reviewed_at: null,
  review_notes: null,
};

function exec(name: string, year: number, total: string, pos = "Chief Executive Officer"): ExecutiveCompRow {
  return {
    executive_name: name,
    principal_position: pos,
    year,
    salary: "1,000,000",
    bonus: null,
    stock_awards: total === "0" ? "0" : String(Number(total.replaceAll(",", "")) - 1_000_000),
    option_awards: null,
    non_equity_incentive_plan_compensation: null,
    all_other_compensation: null,
    total,
    source_excerpt: "test",
  };
}

function policy(type: string, value: string | null, excerpt = "test"): PolicyFactRow {
  return {
    id: type,
    filing_id: "test",
    section_id: null,
    policy_type: type,
    normalized_value: value,
    summary: null,
    source_excerpt: excerpt,
    confidence_score: 0.9,
    ...provenance,
  };
}

function metric(name: string, value: string | null, excerpt = "test"): MetricFactRow {
  return {
    id: name,
    filing_id: "test",
    section_id: null,
    metric_name_raw: name,
    metric_name_normalized: name,
    metric_category: null,
    plan_type: null,
    observed_value: value,
    source_excerpt: excerpt,
    confidence_score: 0.9,
    ...provenance,
  };
}

function peerGroup(
  name: string,
  type: string | null,
  members: { id: string; name: string; ticker: string | null }[],
): PeerGroupRow {
  return {
    id: name,
    filing_id: "test",
    section_id: null,
    peer_group_name: name,
    peer_group_type: type,
    disclosed_year: null,
    selection_rationale: null,
    source_excerpt: "test",
    confidence_score: 0.95,
    members: members.map((m) => ({
      id: m.id,
      peer_group_id: name,
      company_name_raw: m.name,
      company_id_resolved: m.id,
      company_name_resolved: m.name,
      ticker_resolved: m.ticker,
      cik_resolved: null,
      resolution_confidence: 0.95,
    })),
    ...provenance,
  };
}

describe("magnitude", () => {
  it("strips currency + commas and returns numeric", () => {
    expect(magnitude("$1,234,567")).toBe(1234567);
    expect(magnitude("0")).toBe(0);
  });
  it("returns null for non-numeric or empty", () => {
    expect(magnitude(null)).toBe(null);
    expect(magnitude("")).toBe(null);
    expect(magnitude("maximum payout")).toBe(null);
  });
});

describe("diffPeerGroups", () => {
  it("flags additions / removals / kept against the matched group type", () => {
    const from = [
      peerGroup("2024 Primary", "primary", [
        { id: "msft", name: "Microsoft", ticker: "MSFT" },
        { id: "googl", name: "Alphabet", ticker: "GOOGL" },
        { id: "meta", name: "Meta", ticker: "META" },
      ]),
    ];
    const to = [
      peerGroup("2025 Primary", "primary", [
        { id: "msft", name: "Microsoft", ticker: "MSFT" }, // kept
        { id: "googl", name: "Alphabet", ticker: "GOOGL" }, // kept
        { id: "amzn", name: "Amazon", ticker: "AMZN" }, // added
      ]),
    ];
    const diff = diffPeerGroups(from, to);
    expect(diff).toHaveLength(1);
    expect(diff[0].peer_group_type).toBe("primary");
    expect(diff[0].kept).toBe(2);
    expect(diff[0].added.map((m) => m.ticker)).toEqual(["AMZN"]);
    expect(diff[0].removed.map((m) => m.ticker)).toEqual(["META"]);
  });

  it("emits a removed-only entry when a group existed last year and not this year", () => {
    const from = [
      peerGroup("Secondary", "secondary", [
        { id: "ko", name: "Coca-Cola", ticker: "KO" },
      ]),
    ];
    const diff = diffPeerGroups(from, []);
    expect(diff).toHaveLength(1);
    expect(diff[0].peer_group_type).toBe("secondary");
    expect(diff[0].toMembers).toBe(0);
    expect(diff[0].removed.map((m) => m.ticker)).toEqual(["KO"]);
  });

  it("emits an added-only entry when a group is new this year", () => {
    const to = [
      peerGroup("Talent", "talent", [{ id: "x", name: "X", ticker: "X" }]),
    ];
    const diff = diffPeerGroups([], to);
    expect(diff).toHaveLength(1);
    expect(diff[0].fromMembers).toBe(0);
    expect(diff[0].added).toHaveLength(1);
  });
});

describe("diffPolicies", () => {
  it("classifies unchanged / changed / added / removed correctly", () => {
    const from = [
      policy("hedging", "prohibited"),
      policy("clawback", "present"),
      policy("change_in_control", "none"),
    ];
    const to = [
      policy("hedging", "prohibited"), // unchanged
      policy("clawback", "discretionary"), // changed
      policy("compensation_consultant", "independent"), // added
      // change_in_control removed
    ];
    const diff = diffPolicies(from, to);
    const byType = new Map(diff.map((d) => [d.policy_type, d]));
    expect(byType.get("hedging")?.status).toBe("unchanged");
    expect(byType.get("clawback")?.status).toBe("changed");
    expect(byType.get("compensation_consultant")?.status).toBe("added");
    expect(byType.get("change_in_control")?.status).toBe("removed");
  });

  it("orders material changes ahead of unchanged", () => {
    const from = [policy("a", "x"), policy("b", "y")];
    const to = [policy("a", "z"), policy("b", "y")];
    const diff = diffPolicies(from, to);
    expect(diff[0].policy_type).toBe("a");
    expect(diff[0].status).toBe("changed");
    expect(diff[1].status).toBe("unchanged");
  });
});

describe("diffMetrics", () => {
  it("returns a scale-aware numeric delta when both observed values parse", () => {
    const from = [metric("revenue", "$390 billion")];
    const to = [metric("revenue", "$416.2 billion")];
    const diff = diffMetrics(from, to);
    // 416.2B - 390B = 26.2B
    expect(diff[0].numericDelta).toBeCloseTo(26.2e9, -8);
    expect(diff[0].status).toBe("changed");
  });

  it("does not silently zero out scale mismatches", () => {
    const from = [metric("revenue", "$2 million")];
    const to = [metric("revenue", "$2 billion")];
    const diff = diffMetrics(from, to);
    // 2B - 2M = ~1.998B, not zero
    expect(diff[0].numericDelta).toBeGreaterThan(1e9);
  });

  it("returns null delta when values aren't numeric", () => {
    const from = [metric("annual_incentive_payout", "maximum payout")];
    const to = [metric("annual_incentive_payout", "maximum payout")];
    const diff = diffMetrics(from, to);
    expect(diff[0].numericDelta).toBe(null);
    expect(diff[0].status).toBe("unchanged");
  });
});

describe("diffExecutives", () => {
  it("computes delta + percent delta for the CEO and ranks CEO first", () => {
    const from = [
      exec("Tim Cook", 2024, "63,209,845"),
      exec("Luca Maestri", 2024, "27,164,889", "Senior Vice President and Chief Financial Officer"),
    ];
    const to = [
      exec("Tim Cook", 2025, "74,294,811"),
      exec("Kevan Parekh", 2025, "26,000,000", "Senior Vice President and Chief Financial Officer"),
    ];
    const diff = diffExecutives(from, to);
    expect(diff[0].executive_name).toBe("Tim Cook");
    expect(diff[0].isCEO).toBe(true);
    expect(diff[0].totalDelta).toBeCloseTo(11084966, 0);
    expect(diff[0].totalDeltaPct).toBeGreaterThan(15);

    const added = diff.find((d) => d.executive_name === "Kevan Parekh");
    const removed = diff.find((d) => d.executive_name === "Luca Maestri");
    expect(added?.status).toBe("added");
    expect(removed?.status).toBe("removed");
  });
});

describe("summarizeDiff", () => {
  it("collapses sub-diffs into a top-level shape suitable for the page header", () => {
    const peerChanges = diffPeerGroups(
      [
        peerGroup("p", "primary", [
          { id: "a", name: "A", ticker: "A" },
          { id: "b", name: "B", ticker: "B" },
        ]),
      ],
      [
        peerGroup("p", "primary", [
          { id: "a", name: "A", ticker: "A" },
          { id: "c", name: "C", ticker: "C" },
        ]),
      ],
    );
    const policyChanges = diffPolicies(
      [policy("clawback", "present")],
      [policy("clawback", "discretionary"), policy("hedging", "prohibited")],
    );
    const metricChanges = diffMetrics([metric("revenue", "$1B")], [metric("revenue", "$2B")]);
    const execChanges = diffExecutives(
      [exec("CEO", 2024, "10,000,000")],
      [exec("CEO", 2025, "12,000,000")],
    );

    const summary = summarizeDiff({ peerChanges, policyChanges, metricChanges, execChanges });
    expect(summary.peerAdded).toBe(1);
    expect(summary.peerRemoved).toBe(1);
    expect(summary.policiesChanged).toBe(1);
    expect(summary.policiesAdded).toBe(1);
    expect(summary.metricsChanged).toBe(1);
    expect(summary.ceoTotalDelta).toBe(2_000_000);
  });
});

describe("sectionSimilarity", () => {
  it("returns 100 for identical text", () => {
    const a = "the compensation discussion and analysis explains the program structure of pay";
    expect(sectionSimilarity(a, a)).toBe(100);
  });
  it("returns 0 for fully disjoint text", () => {
    expect(sectionSimilarity("alpha beta gamma delta epsilon", "one two three four five")).toBe(0);
  });
  it("returns intermediate value for partially overlapping text", () => {
    const a = "compensation discussion and analysis section opens with our pay philosophy explained in plain language and detail";
    const b = "compensation discussion and analysis section opens with our different framing for pay structure not pay philosophy";
    const sim = sectionSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(100);
  });
});
