import { describe, expect, it } from "vitest";

import { diffFixture } from "./comparator";

describe("diffFixture", () => {
  it("reports match=true on identical objects", () => {
    const a = { name: "AAPL", year: 2025 };
    const r = diffFixture(a, a, "sections", { filing_dir: "aapl/x" });
    expect(r.match).toBe(true);
    expect(r.regressions).toEqual([]);
  });

  it("ignores autoinc ids and timestamps", () => {
    const oracle = { id: 1, name: "x", created_at: "2026-01-01" };
    const cand = { id: 999, name: "x", created_at: "2026-04-01" };
    const r = diffFixture(cand, oracle, "policy_facts", { filing_dir: "x/y" });
    expect(r.match).toBe(true);
  });

  it("downgrades confidence_score diffs to warnings", () => {
    const oracle = { policy_type: "clawback", confidence_score: 0.9 };
    const cand = { policy_type: "clawback", confidence_score: 0.95 };
    const r = diffFixture(cand, oracle, "policy_facts", { filing_dir: "x/y" });
    expect(r.match).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].field).toBe("confidence_score");
  });

  it("flags a real value mismatch as a regression", () => {
    const oracle = { policy_type: "clawback", normalized_value: "yes" };
    const cand = { policy_type: "clawback", normalized_value: "no" };
    const r = diffFixture(cand, oracle, "policy_facts", { filing_dir: "x/y" });
    expect(r.match).toBe(false);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].field).toBe("normalized_value");
  });

  it("compares arrays element-by-element", () => {
    const r = diffFixture(
      [{ a: 1 }, { a: 2 }],
      [{ a: 1 }, { a: 3 }],
      "metric_facts",
      { filing_dir: "x/y" },
    );
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].path).toBe("[1].a");
  });

  it("reports text-SHA changes for large field diffs separately", () => {
    const oracle = { text: "a".repeat(500) };
    const cand = { text: "b".repeat(500) };
    const r = diffFixture(cand, oracle, "sections", { filing_dir: "x/y" });
    expect(r.text_sha_changes).toHaveLength(1);
    expect(r.regressions).toHaveLength(1);
  });
});
