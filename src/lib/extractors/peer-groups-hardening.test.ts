/**
 * Regression tests for two peer-extractor quality fixes surfaced by the
 * post-recovery review of the frozen cohort:
 *
 *  1. Ticker-inline path matched compensation-table footnote legends —
 *     "Contribution (A)", "Aircraft Usage (F)", "Personal Security (G)" —
 *     as Name+(TICKER) pairs, because A/B/C/D/E/F/G are all real
 *     one-letter NYSE tickers. CRM FY2026 emitted a bogus 7-member A–G
 *     peer group this way. Single-letter tickers are now skipped in the
 *     inline path.
 *
 *  2. "Merck & Co., Inc." failed to resolve from a bare "Merck" in a
 *     peer list: stripping "Co"/"Inc" left a dangling ampersand so the
 *     short alias was "merck and", which never matched. The resolver now
 *     drops the trailing conjunction so the short alias is "merck".
 */
import { describe, expect, it } from "vitest";

import {
  extractPeerGroupsFromTickerInline,
  resolveCompanyName,
} from "./peer-groups";

const HEAD = `<!doctype html><html><body>`;
const FOOT = `</body></html>`;

describe("ticker-inline: single-letter (footnote-legend) rejection", () => {
  it("does NOT emit a peer group from an All-Other-Compensation footnote legend", () => {
    // The CRM FY2026 shape: a compensation footnote legend whose markers
    // (A)-(G) collide with real one-letter tickers.
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <p>All Other Compensation. The amounts reported include:
      Contribution (A) Other Amounts (B) Non-Employee Director Fees (C)
      HSR Filing Fee (D) Tax Gross-up (E) Aircraft Usage (F)
      Personal Security (G)</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("crm-legend", html);
    expect(groups).toEqual([]);
  });

  it("still extracts a real Name+(TICKER) run with multi-character tickers", () => {
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <p>Apple Inc. (AAPL) Microsoft Corporation (MSFT) Netflix, Inc. (NFLX)
      Amazon.com, Inc. (AMZN) Meta Platforms, Inc. (META)
      Oracle Corporation (ORCL) Adobe Inc. (ADBE)</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("real-inline", html);
    expect(groups).toHaveLength(1);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("MSFT");
    expect(tickers.length).toBeGreaterThanOrEqual(7);
  });

  it("keeps a one-letter ticker when the captured name confirms it", () => {
    // "Ford Motor Company (F)" is a real peer cited by a one-letter
    // ticker; the name resolves to Ford, so the pair is kept even though
    // the ticker is a single character.
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <p>Apple Inc. (AAPL) Microsoft Corporation (MSFT) Netflix, Inc. (NFLX)
      Amazon.com, Inc. (AMZN) Meta Platforms, Inc. (META)
      Oracle Corporation (ORCL) Ford Motor Company (F)</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("one-letter-real", html);
    expect(groups).toHaveLength(1);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).toContain("F");
    expect(tickers).toContain("AAPL");
  });

  it("drops only the single-letter member from an otherwise valid run", () => {
    // Eight pairs, one of which uses a bare single-letter ticker. The
    // single-letter pair is skipped; the other seven still form a group.
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <p>Apple Inc. (AAPL) Microsoft Corporation (MSFT) Netflix, Inc. (NFLX)
      Amazon.com, Inc. (AMZN) Meta Platforms, Inc. (META)
      Oracle Corporation (ORCL) Adobe Inc. (ADBE) Aircraft Usage (F)</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("mixed", html);
    expect(groups).toHaveLength(1);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).not.toContain("F");
    expect(tickers).toContain("AAPL");
  });
});

describe("resolver: Merck & Co. short alias", () => {
  it("resolves a bare 'Merck' to MRK", () => {
    const r = resolveCompanyName("Merck");
    expect(r.ticker).toBe("MRK");
  });

  it("resolves 'Merck & Co., Inc.' to MRK", () => {
    const r = resolveCompanyName("Merck & Co., Inc.");
    expect(r.ticker).toBe("MRK");
  });

  it("does not regress existing resolutions", () => {
    expect(resolveCompanyName("Apple Inc.").ticker).toBe("AAPL");
    expect(resolveCompanyName("Palo Alto Networks, Inc.").ticker).toBe("PANW");
    // The dangling-conjunction strip must not break "X & Y" names whose
    // conjunction is internal (not trailing).
    expect(resolveCompanyName("AT&T Inc.").ticker).toBe("T");
  });
});
