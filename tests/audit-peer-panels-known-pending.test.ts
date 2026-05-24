/**
 * Phase 24 — pin the known-pending pollution classifier.
 *
 * The CI `audit cohort peer panels` job fails non-zero whenever
 * production has polluted peer rows. While the Neon-quota blocker
 * is in effect, the SAME pollution will reappear on every run. We
 * still fail (no silent passes), but we want the failure annotated
 * so an operator can tell "external blocker" apart from "fresh
 * regression" without reading the chip list themselves.
 *
 * The classifier is a pure function with no I/O — these tests cover
 * the three branches: all-known, partial-match-with-new-pair, and
 * unrelated-pollution.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — pure ESM helper, no .d.ts; runtime import works.
import {
  BLOCKER_DESCRIPTION,
  KNOWN_PENDING_POLLUTION,
  RESET_ETA_LABEL,
  classifyKnownPendingPollution,
  formatKnownPendingAnnotationBody,
} from "../scripts/lib/known-pending-pollution.mjs";

interface Pair {
  parent: string;
  ticker: string;
}

describe("classifyKnownPendingPollution (Phase 24)", () => {
  it("returns allKnown=true when every dirty chip is in the known-pending map", () => {
    const results = [
      { ticker: "crm", dirty: [{ ticker: "HEPS" }, { ticker: "FIVE" }] },
      { ticker: "nflx", dirty: [{ ticker: "HEPS" }, { ticker: "SFWJ" }] },
      { ticker: "qcom", dirty: [{ ticker: "HEPS" }] },
    ];
    const c = classifyKnownPendingPollution(results);
    expect(c.allKnown).toBe(true);
    expect(c.unknownPairs).toEqual([]);
    expect(c.knownMatches.map((m) => m.parent).sort()).toEqual([
      "crm",
      "nflx",
      "qcom",
    ]);
  });

  it("returns allKnown=false when ANY dirty chip is outside the map (fresh regression signal)", () => {
    const results = [
      // CRM has all known chips...
      { ticker: "crm", dirty: [{ ticker: "HEPS" }] },
      // ...but AAPL has a never-before-seen suspect.
      { ticker: "aapl", dirty: [{ ticker: "ZZZZ" }] },
    ];
    const c = classifyKnownPendingPollution(results);
    expect(c.allKnown).toBe(false);
    expect(c.unknownPairs).toContainEqual<Pair>({
      parent: "aapl",
      ticker: "ZZZZ",
    });
  });

  it("returns allKnown=false when a KNOWN parent has an UNKNOWN suspect ticker", () => {
    // CRM is in the map but ZZZZ is not in its expected suspect set.
    // Even though the parent ticker matches, the (parent, ticker)
    // PAIR is unexpected — must read as a fresh regression so the
    // failure isn't blandly attributed to the external blocker.
    const results = [{ ticker: "crm", dirty: [{ ticker: "ZZZZ" }] }];
    const c = classifyKnownPendingPollution(results);
    expect(c.allKnown).toBe(false);
    expect(c.unknownPairs).toContainEqual<Pair>({
      parent: "crm",
      ticker: "ZZZZ",
    });
  });

  it("missingExpected captures pairs that USED to be in the known-pending set but were not seen", () => {
    // Audit found CRM/HEPS only — KFII/TBTC/FIVE/ABVE on CRM,
    // NFLX entirely, QCOM entirely are all expected but missing.
    // Useful as a partial-recovery indicator after a successful run.
    const results = [{ ticker: "crm", dirty: [{ ticker: "HEPS" }] }];
    const c = classifyKnownPendingPollution(results);
    const parents = c.missingExpected.map((m) => m.parent).sort();
    expect(parents).toEqual(["crm", "nflx", "qcom"]);
    const crm = c.missingExpected.find((m) => m.parent === "crm")!;
    expect(crm.tickers.sort()).toEqual(
      ["ABVE", "FIVE", "KFII", "TBTC"].sort(),
    );
  });

  it("allKnown=false when no pollution at all (annotation should not fire)", () => {
    const c = classifyKnownPendingPollution([]);
    expect(c.allKnown).toBe(false);
    expect(c.knownMatches).toEqual([]);
  });

  it("is parent-case-insensitive on the input ticker (audit uses lowercase IDs)", () => {
    const results = [{ ticker: "CRM", dirty: [{ ticker: "HEPS" }] }];
    const c = classifyKnownPendingPollution(results);
    expect(c.allKnown).toBe(true);
    expect(c.knownMatches[0].parent).toBe("crm");
  });
});

describe("formatKnownPendingAnnotationBody (Phase 24)", () => {
  it("returns null when classification is not allKnown (no annotation should be emitted)", () => {
    expect(
      formatKnownPendingAnnotationBody({
        allKnown: false,
        knownMatches: [],
        unknownPairs: [],
        missingExpected: [],
      }),
    ).toBeNull();
  });

  it("includes the blocker description and reset ETA when allKnown", () => {
    const body = formatKnownPendingAnnotationBody({
      allKnown: true,
      knownMatches: [{ parent: "crm", tickers: ["HEPS", "FIVE"] }],
      unknownPairs: [],
      missingExpected: [],
    });
    expect(body).not.toBeNull();
    expect(body).toContain(BLOCKER_DESCRIPTION);
    expect(body).toContain(RESET_ETA_LABEL);
    expect(body).toContain("CRM=[FIVE,HEPS]"); // tickers alphabetized
    expect(body).toContain("does NOT indicate a fresh regression");
  });
});

describe("KNOWN_PENDING_POLLUTION shape contract", () => {
  it("uses lowercase parent keys (audit emits lowercased IDs)", () => {
    for (const key of KNOWN_PENDING_POLLUTION.keys()) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("uses uppercase suspect tickers (matches peer_group_members.ticker_resolved convention)", () => {
    for (const set of KNOWN_PENDING_POLLUTION.values()) {
      for (const t of set) {
        expect(t).toBe(t.toUpperCase());
      }
    }
  });
});
