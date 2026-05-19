/**
 * Phase 9 regression tests for `extractPeerGroupsFromTickerInline`.
 *
 * Modern iXBRL filings (TGT, MA, HBAN, etc.) render their peer list
 * as a sequence of `Name (TICKER)` pairs inside coordinate-positioned
 * divs. The extractor strips HTML tags, scans the linear text for
 * runs of those pairs, validates each ticker against SEC's universe,
 * and emits a group when ≥7 valid pairs appear in proximity to a
 * peer-group heading.
 *
 * Tests pin both the positive shapes (TGT/MA/HBAN-style) and the
 * negative guards (random `(ABC)` mentions in prose, runs without a
 * heading nearby, runs with mostly-invalid tickers).
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroupsFromTickerInline } from "./peer-groups";

const HEAD = `<!doctype html><html><body>`;
const FOOT = `</body></html>`;

describe("extractPeerGroupsFromTickerInline", () => {
  it("MA-style: 'Name (TICKER)' bullet list inline", () => {
    // Mastercard's peer panel renders as positioned divs each
    // containing one `Name (TICKER)` bullet. After tag-strip the
    // text becomes a clean sequence.
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <div>
        <span>Microsoft (MSFT)</span>
        <span>Oracle (ORCL)</span>
        <span>Adobe (ADBE)</span>
        <span>Salesforce (CRM)</span>
        <span>Booking Holdings (BKNG)</span>
        <span>Intuit (INTU)</span>
        <span>Cisco (CSCO)</span>
        <span>NVIDIA (NVDA)</span>
        <span>Visa (V)</span>
      </div>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("ma-test", html);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.length).toBeGreaterThanOrEqual(8);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).toContain("MSFT");
    expect(tickers).toContain("CRM");
    expect(tickers).toContain("NVDA");
  });

  it("TGT-style: long inline run with multiple peer groups (retail + general)", () => {
    const html = `${HEAD}
      <h2>Compensation peer group</h2>
      <div>Best Buy Co., Inc. (BBY) The Kroger Co. (KR) Costco Wholesale Corporation (COST)
      Lowe's Companies, Inc. (LOW) The TJX Companies, Inc. (TJX) Target Corporation (TGT)
      Walmart Inc. (WMT) The Home Depot, Inc. (HD) Dollar General Corporation (DG)
      Ross Stores, Inc. (ROST) Dollar Tree, Inc. (DLTR)</div>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("tgt-test", html);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const tickers = groups.flatMap((g) => g.members.map((m) => m.ticker_resolved));
    expect(tickers).toContain("BBY");
    expect(tickers).toContain("COST");
    expect(tickers).toContain("WMT");
  });

  it("rejects a single isolated 'Name (TICKER)' mention (no run)", () => {
    // A throwaway "Microsoft (MSFT)" inside CD&A prose mustn't count
    // as a peer group on its own.
    const html = `${HEAD}
      <h2>Compensation Discussion</h2>
      <p>We've benchmarked compensation against Microsoft (MSFT) for the
      relative TSR comparison only, which is separate from our peer
      group analysis.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("noise-1", html);
    expect(groups).toEqual([]);
  });

  it("rejects runs that aren't preceded by a peer-group heading", () => {
    // Run of valid Name (TICKER) pairs but no peer-group heading
    // anywhere nearby. Must not emit a group.
    const html = `${HEAD}
      <h1>Executive Officers</h1>
      <div>
        Microsoft (MSFT) Oracle (ORCL) Adobe (ADBE) Salesforce (CRM)
        Booking Holdings (BKNG) Intuit (INTU) Cisco (CSCO) NVIDIA (NVDA)
      </div>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("noise-2", html);
    expect(groups).toEqual([]);
  });

  it("rejects runs where tickers don't match SEC's universe", () => {
    // Made-up tickers that look right but aren't in SEC's list.
    const html = `${HEAD}
      <h2>Compensation Peer Group</h2>
      <div>
        Foo Corp (FOO) Bar Inc (BAR) Baz Holdings (BAZ) Qux Ltd (QUX)
        Wiz Co (WIZ) Plop Corp (PLOP) Wibble Inc (WIBBLE) Zorp Co (ZORP)
      </div>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("noise-3", html);
    // None of these tickers exist in SEC's universe → no valid members → no group
    expect(groups).toEqual([]);
  });

  it("dedupes the same ticker appearing twice in a run", () => {
    const html = `${HEAD}
      <h3>Peer Group</h3>
      <div>
        Microsoft (MSFT) Oracle (ORCL) Adobe (ADBE) Salesforce (CRM)
        Microsoft (MSFT) Intuit (INTU) Cisco (CSCO) NVIDIA (NVDA) Visa (V)
      </div>
    ${FOOT}`;
    const groups = extractPeerGroupsFromTickerInline("dedupe", html);
    expect(groups.length).toBe(1);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    const msftCount = tickers.filter((t) => t === "MSFT").length;
    expect(msftCount).toBe(1);
  });
});
