/**
 * Phase 30 — pin the search-snippet highlight split logic.
 *
 * The SearchView component renders each part as a <mark> or <span>;
 * the split is pure and lives in `./highlight.ts` so vitest covers
 * the edge cases without a DOM.
 */
import { describe, expect, it } from "vitest";

import { escapeRegex, splitSnippetForHighlight } from "./highlight";

describe("escapeRegex (Phase 30)", () => {
  it("escapes every regex metacharacter", () => {
    expect(escapeRegex(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });

  it("leaves plain alphanumerics untouched", () => {
    expect(escapeRegex("clawback policy 2024")).toBe("clawback policy 2024");
  });

  it("escapes parentheses so '(d)(2)' becomes a literal match", () => {
    // The /api/search route surfaces Item 402(u) etc.; an analyst
    // searching for "402(u)" must NOT have the parens read as a regex
    // group — they'd otherwise match every 'u' in the snippet.
    expect(escapeRegex("402(u)")).toBe("402\\(u\\)");
  });
});

describe("splitSnippetForHighlight (Phase 30)", () => {
  it("returns the full snippet as a single non-match part on empty query", () => {
    expect(
      splitSnippetForHighlight("hedging policy disclosed in proxy", ""),
    ).toEqual([{ text: "hedging policy disclosed in proxy", isMatch: false }]);
  });

  it("returns the full snippet as a single non-match part on no match", () => {
    expect(
      splitSnippetForHighlight("hedging policy disclosed in proxy", "clawback"),
    ).toEqual([{ text: "hedging policy disclosed in proxy", isMatch: false }]);
  });

  it("splits a single match into three parts (before, match, after)", () => {
    expect(
      splitSnippetForHighlight("hedging policy disclosed", "policy"),
    ).toEqual([
      { text: "hedging ", isMatch: false },
      { text: "policy", isMatch: true },
      { text: " disclosed", isMatch: false },
    ]);
  });

  it("matches case-insensitively but preserves the snippet's original casing", () => {
    expect(splitSnippetForHighlight("Clawback Policy", "policy")).toEqual([
      { text: "Clawback ", isMatch: false },
      { text: "Policy", isMatch: true },
      { text: "", isMatch: false },
    ]);
  });

  it("returns alternating parts when the same term matches multiple times", () => {
    const parts = splitSnippetForHighlight("pay and pay ratio", "pay");
    expect(parts).toEqual([
      { text: "", isMatch: false },
      { text: "pay", isMatch: true },
      { text: " and ", isMatch: false },
      { text: "pay", isMatch: true },
      { text: " ratio", isMatch: false },
    ]);
  });

  it("treats regex-meta query as a literal-string search", () => {
    // Searching for "Item 402(u)" must literally match "Item 402(u)"
    // and not throw or read the parens as a regex group.
    const parts = splitSnippetForHighlight(
      "Per Item 402(u) the disclosure …",
      "Item 402(u)",
    );
    const matches = parts.filter((p) => p.isMatch).map((p) => p.text);
    expect(matches).toEqual(["Item 402(u)"]);
  });

  it("handles a query that is the entire snippet", () => {
    const parts = splitSnippetForHighlight("clawback", "clawback");
    expect(parts).toEqual([
      { text: "", isMatch: false },
      { text: "clawback", isMatch: true },
      { text: "", isMatch: false },
    ]);
  });

  it("starts with an empty non-match when the snippet begins with the match", () => {
    const parts = splitSnippetForHighlight("clawback policy", "clawback");
    expect(parts[0]).toEqual({ text: "", isMatch: false });
    expect(parts[1]).toEqual({ text: "clawback", isMatch: true });
  });
});
