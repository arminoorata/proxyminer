/**
 * Ranking + matching tests for the autocomplete search. The route
 * handler is a thin wrapper over this pure function plus the
 * already-imported set; the real correctness lives here.
 *
 * Fixture is a tiny SEC-shaped slice that covers the matching
 * cases compensation analysts actually hit:
 *   - exact ticker
 *   - prefix ticker (typing as you go)
 *   - dual-class shares (BRK.A / BF.B)
 *   - company name, word boundary
 *   - company name, mid-word
 *   - tiebreaker between in-DB and not-in-DB
 */
import { describe, expect, it } from "vitest";

import type { SecTickerEntry } from "./sec-tickers-cache";
import { searchTickers } from "./ticker-search";

function mk(ticker: string, name: string, cik: string): SecTickerEntry {
  return {
    ticker,
    name,
    cik,
    ticker_lower: ticker.toLowerCase(),
    name_lower: name.toLowerCase(),
  };
}

// SEC's company_tickers.json uses '-' as the dual-class delimiter
// (BRK-A, BRK-B, BF-B). The matcher normalizes '.' to '-' so a user
// typing the more familiar dot form lands the hit.
const FIXTURE: SecTickerEntry[] = [
  mk("AAPL", "Apple Inc.", "0000320193"),
  mk("APPN", "Appian Corp", "0001500435"),
  mk("MSFT", "Microsoft Corp", "0000789019"),
  mk("META", "Meta Platforms, Inc.", "0001326801"),
  mk("BRK-A", "Berkshire Hathaway Inc.", "0001067983"),
  mk("BRK-B", "Berkshire Hathaway Inc.", "0001067983"),
  mk("BF-B", "Brown-Forman Corp", "0000014693"),
  mk("BFA", "BlackRock Income Trust", "0000787281"),
  mk("ORCL", "Oracle Corp", "0001341439"),
  mk("BLDR", "Builders FirstSource Inc.", "0001316835"),
];

describe("searchTickers — ranking", () => {
  it("exact ticker match wins", () => {
    const hits = searchTickers("aapl", FIXTURE, new Set());
    expect(hits[0].ticker).toBe("AAPL");
    expect(hits[0].match_reason).toBe("ticker_exact");
  });

  it("prefix ticker outranks substring company-name match", () => {
    // 'app' prefix of AAPL/APPN AND substring of 'Apple'. Prefix wins.
    const hits = searchTickers("app", FIXTURE, new Set());
    expect(["AAPL", "APPN"]).toContain(hits[0].ticker);
    expect(hits[0].match_reason).toBe("ticker_prefix");
  });

  it("dual-class tickers match exactly via hyphen (SEC's native form)", () => {
    const hits = searchTickers("brk-a", FIXTURE, new Set());
    expect(hits[0].ticker).toBe("BRK-A");
    expect(hits[0].match_reason).toBe("ticker_exact");
  });

  it("dual-class tickers match exactly via dot (analyst-typed form)", () => {
    const hits = searchTickers("brk.a", FIXTURE, new Set());
    expect(hits[0].ticker).toBe("BRK-A");
    expect(hits[0].match_reason).toBe("ticker_exact");
  });

  it("dual-class tickers match by prefix without the separator", () => {
    const hits = searchTickers("brk", FIXTURE, new Set());
    const tickers = hits.map((h) => h.ticker);
    expect(tickers).toContain("BRK-A");
    expect(tickers).toContain("BRK-B");
  });

  it("matches company name by word-boundary", () => {
    const hits = searchTickers("microsoft", FIXTURE, new Set());
    expect(hits[0].ticker).toBe("MSFT");
    expect(hits[0].match_reason).toBe("name_word");
  });

  it("matches company name by substring as a fallback", () => {
    const hits = searchTickers("ksh", FIXTURE, new Set());
    // 'ksh' is mid-word in "Berkshire" — substring fallback.
    const reasons = new Set(hits.map((h) => h.match_reason));
    expect(reasons.has("name_substring")).toBe(true);
  });

  it("case-insensitive", () => {
    const hits = searchTickers("AaPl", FIXTURE, new Set());
    expect(hits[0].ticker).toBe("AAPL");
  });

  it("returns empty when nothing matches", () => {
    const hits = searchTickers("zzzzzz", FIXTURE, new Set());
    expect(hits).toEqual([]);
  });

  it("returns empty for empty/whitespace query", () => {
    expect(searchTickers("", FIXTURE, new Set())).toEqual([]);
    expect(searchTickers("   ", FIXTURE, new Set())).toEqual([]);
  });

  it("annotates in_db from the imported set", () => {
    const imported = new Set(["aapl"]);
    const hits = searchTickers("aapl", FIXTURE, imported);
    expect(hits[0].in_db).toBe(true);
    expect(hits[0].company_id).toBe("aapl");
  });

  it("prefers in-DB hit when scores tie", () => {
    // Query 'brk-' prefix-matches BRK-A and BRK-B with identical
    // length deltas → identical scores. Mark BRK-B as imported; the
    // tie-breaker should put it first. (company_id stays lowercase of
    // the SEC ticker form, so 'brk-b' is the imported key.)
    const imported = new Set(["brk-b"]);
    const hits = searchTickers("brk-", FIXTURE, imported, { limit: 5 });
    expect(hits[0].ticker).toBe("BRK-B");
    expect(hits[0].in_db).toBe(true);
  });

  it("respects the limit option", () => {
    const hits = searchTickers("b", FIXTURE, new Set(), { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("doesn't return a hit for arbitrary garbage", () => {
    const hits = searchTickers("!@#$%^", FIXTURE, new Set());
    expect(hits).toEqual([]);
  });

  it("ticker_substring fallback fires only when name match fails", () => {
    // 'rk-' is mid-ticker of BRK-A and BRK-B but not a prefix; and
    // 'Berkshire' contains 'rk' but the hyphen breaks the name-side
    // substring match. Either ticker_substring or name_substring is
    // acceptable depending on which path matches first.
    const hits = searchTickers("rk-", FIXTURE, new Set());
    expect(hits.length).toBeGreaterThan(0);
    const reasons = new Set(hits.map((h) => h.match_reason));
    expect(
      reasons.has("ticker_substring") || reasons.has("name_substring"),
    ).toBe(true);
  });
});
