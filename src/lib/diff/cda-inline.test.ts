import { describe, expect, it } from "vitest";

import {
  diffCdaSentences,
  splitIntoSentences,
  wordDiff,
} from "./cda-inline";

describe("splitIntoSentences", () => {
  it("splits on sentence terminators + paragraph breaks", () => {
    const out = splitIntoSentences("First sentence. Second sentence.\n\nThird paragraph!");
    expect(out).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third paragraph!",
    ]);
  });

  it("doesn't split on common abbreviations", () => {
    const out = splitIntoSentences("Mr. Smith presented to the board. He was elected.");
    expect(out).toEqual([
      "Mr. Smith presented to the board.",
      "He was elected.",
    ]);
    expect(splitIntoSentences("Inc. and Corp. are types.")).toEqual([
      "Inc. and Corp. are types.",
    ]);
  });

  it("doesn't split on decimal numbers", () => {
    expect(splitIntoSentences("Revenue grew to $3.5 billion. EBIT was $1.2 billion.")).toEqual([
      "Revenue grew to $3.5 billion.",
      "EBIT was $1.2 billion.",
    ]);
  });

  it("returns [] for empty / whitespace input", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   \n  ")).toEqual([]);
  });
});

describe("wordDiff", () => {
  it("identifies replaced tokens", () => {
    const ops = wordDiff("CEO base salary grew to $1.5 million", "CEO base salary grew to $1.6 million");
    // Backtrack-order for tied LCS choices isn't load-bearing for
    // rendering — both `del:$1.5` and `ins:$1.6` must be present.
    const changes = new Set(ops.filter((o) => o.type !== "same").map((o) => `${o.type}:${o.text}`));
    expect(changes).toEqual(new Set(["del:$1.5", "ins:$1.6"]));
    // Surrounding tokens unchanged.
    const same = ops.filter((o) => o.type === "same").map((o) => o.text);
    expect(same).toEqual(["CEO", "base", "salary", "grew", "to", "million"]);
  });

  it("handles pure insertion, using NEW-side text for same-tokens", () => {
    // The new text uses lowercase "compensation"; that's what the
    // "same" op should carry (we always render the new-doc casing).
    const ops = wordDiff("Compensation review.", "Annual compensation review.");
    expect(ops.map((o) => `${o.type}:${o.text}`)).toEqual([
      "ins:Annual",
      "same:compensation",
      "same:review.",
    ]);
  });

  it("handles pure deletion", () => {
    const ops = wordDiff("Annual compensation review.", "Compensation review.");
    expect(ops.map((o) => `${o.type}:${o.text}`)).toEqual([
      "del:Annual",
      "same:Compensation",
      "same:review.",
    ]);
  });
});

describe("diffCdaSentences", () => {
  it("classifies pure additions and deletions in document order", () => {
    const oldText = "Our compensation philosophy is unchanged. We rely on three pillars.";
    const newText =
      "Our compensation philosophy is unchanged. We rely on four pillars. The fourth pillar is new.";
    const result = diffCdaSentences(oldText, newText);
    expect(result.counts.unchanged).toBe(1);
    expect(result.counts.added).toBeGreaterThanOrEqual(1);
    expect(result.counts.changed).toBe(1);
    // The pillars sentence pairs as "changed" (high overlap), and the
    // last sentence is new ("added").
    expect(result.ops.map((o) => o.type)).toEqual([
      "unchanged",
      "changed",
      "added",
    ]);
    const changed = result.ops.find((o) => o.type === "changed");
    if (changed?.type === "changed") {
      const word = changed.wordDiff.find((w) => w.type === "del");
      expect(word?.text).toBe("three");
    }
  });

  it("emits removed sentences from old that didn't pair", () => {
    const oldText =
      "Our peer group includes companies A, B, and C. We reviewed total shareholder return.";
    const newText = "We reviewed total shareholder return. New disclosure about clawback.";
    const result = diffCdaSentences(oldText, newText);
    expect(result.counts.unchanged).toBe(1);
    expect(result.counts.added).toBe(1);
    expect(result.removed).toContain("Our peer group includes companies A, B, and C.");
  });

  it("returns empty for identical inputs", () => {
    const t = "Compensation is set annually. The committee reviews each NEO.";
    const result = diffCdaSentences(t, t);
    expect(result.counts.unchanged).toBe(2);
    expect(result.counts.added).toBe(0);
    expect(result.counts.removed).toBe(0);
    expect(result.counts.changed).toBe(0);
  });

  it("normalizes whitespace and quote style when matching", () => {
    // Smart quotes vs straight quotes should still match.
    const oldText = `The "primary peer group" was reviewed.`;
    const newText = `The “primary peer group” was reviewed.`;
    const result = diffCdaSentences(oldText, newText);
    expect(result.counts.unchanged).toBe(1);
    expect(result.counts.added).toBe(0);
    expect(result.counts.removed).toBe(0);
  });

  it("preserves new-document sentence order in ops", () => {
    const oldText = "B. A.";
    const newText = "A. B. C.";
    const result = diffCdaSentences(oldText, newText);
    // ops are walked in newText order — "A.", "B.", "C." — A and B
    // are unchanged in some order, C is added.
    expect(result.ops.map((o) => o.type)).toEqual(["unchanged", "unchanged", "added"]);
    const c = result.ops[2];
    expect(c.type === "added" && c.newText).toBe("C.");
  });

  it("handles empty filings on either side", () => {
    expect(diffCdaSentences("", "").counts).toEqual({
      unchanged: 0, added: 0, removed: 0, changed: 0,
    });
    const onlyNew = diffCdaSentences("", "New sentence.");
    expect(onlyNew.counts.added).toBe(1);
    const onlyOld = diffCdaSentences("Old sentence.", "");
    expect(onlyOld.counts.removed).toBe(1);
  });
});
