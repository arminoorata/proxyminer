/**
 * Phase 10 regression tests for `extractPeerGroupsFromSuffixEnumeration`.
 *
 * Two real-cohort shapes drive the design:
 *
 *  - DIS-style: comma-separated prose enumeration outside CD&A
 *    ("Apple Inc., AT&T Inc., Charter Communications, Inc., …, and
 *    Warner Bros. Discovery, Inc.")
 *
 *  - WMT-style: bullet list with one company per <p> / <div> — after
 *    tag-strip the text concatenates names with spaces. The extractor
 *    inserts `|` separators at block-level closing tags so each name
 *    stays bounded.
 *
 * Both shapes are gated by an upstream peer-group heading + SEC-name
 * resolution + ≥7-match-run; tests cover the positive shapes plus
 * the false-positive guards (prose mentions, heading-noise names,
 * boundary-crossing matches).
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroupsFromSuffixEnumeration } from "./peer-groups";

const HEAD = `<!doctype html><html><body>`;
const FOOT = `</body></html>`;

describe("extractPeerGroupsFromSuffixEnumeration", () => {
  it("DIS-style: comma-separated prose enumeration", () => {
    const html = `${HEAD}
      <h3>Compensation peer group</h3>
      <p>The 2025 peer group is composed of the following companies:
      Apple Inc., AT&T Inc., Charter Communications, Inc., Comcast Corporation,
      International Business Machines Corporation, Meta Platforms, Inc.,
      Microsoft Corporation, Netflix, Inc., NIKE, Inc., Oracle Corporation,
      Salesforce, Inc., T-Mobile US, Inc., Verizon Communications Inc.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("dis-test", html);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.length).toBeGreaterThanOrEqual(8);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("NFLX");
    expect(tickers).toContain("MSFT");
  });

  it("WMT-style: bullet list with one company per <p>", () => {
    const html = `${HEAD}
      <h2>Walmart Proxy Peer Group</h2>
      <p>Albertsons Companies Inc.</p>
      <p>Alphabet Inc.</p>
      <p>Amazon.com Inc.</p>
      <p>American Express Company</p>
      <p>Apple Inc.</p>
      <p>Comcast Corporation</p>
      <p>Costco Wholesale Corporation</p>
      <p>CVS Health Corp.</p>
      <p>The Home Depot, Inc.</p>
      <p>JPMorgan Chase &amp; Co.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("wmt-test", html);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.length).toBeGreaterThanOrEqual(8);
    const tickers = groups[0].members.map((m) => m.ticker_resolved);
    expect(tickers).toContain("COST");
    expect(tickers).toContain("HD");
    expect(tickers).toContain("AAPL");
  });

  it("rejects a single isolated suffix-terminated mention", () => {
    const html = `${HEAD}
      <h2>Compensation Discussion</h2>
      <p>We've benchmarked compensation against Apple Inc. for the
      relative TSR comparison only.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("noise-1", html);
    expect(groups).toEqual([]);
  });

  it("rejects suffix runs without a peer-group heading nearby", () => {
    const html = `${HEAD}
      <h1>Executive Officers</h1>
      <p>Apple Inc.</p>
      <p>Microsoft Corporation</p>
      <p>Alphabet Inc.</p>
      <p>Amazon.com Inc.</p>
      <p>NIKE, Inc.</p>
      <p>Oracle Corporation</p>
      <p>Salesforce, Inc.</p>
      <p>NVIDIA Corporation</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("noise-2", html);
    expect(groups).toEqual([]);
  });

  it("rejects greedy capture across block boundaries", () => {
    // Without the `|` separator at closing tags, the WMT-style
    // bullet list would yield one giant name like
    // "Walmart Proxy Peer Group Albertsons Companies Inc.". The
    // boundary insertion + name-reject filter must prevent that.
    const html = `${HEAD}
      <h2>Walmart Proxy Peer Group</h2>
      <p>Albertsons Companies Inc.</p>
      <p>Alphabet Inc.</p>
      <p>Amazon.com Inc.</p>
      <p>American Express Company</p>
      <p>Apple Inc.</p>
      <p>Costco Wholesale Corporation</p>
      <p>CVS Health Corp.</p>
      <p>The Home Depot, Inc.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("boundary", html);
    expect(groups).toHaveLength(1);
    // No member's raw name should contain heading-noise words.
    for (const m of groups[0].members) {
      expect(m.company_name_raw).not.toMatch(/Proxy|Peer Group/);
    }
  });

  it("dedupes the same company id within a run", () => {
    const html = `${HEAD}
      <h3>Peer Group</h3>
      <p>Apple Inc.</p>
      <p>Microsoft Corporation</p>
      <p>Apple Inc.</p>
      <p>Alphabet Inc.</p>
      <p>Amazon.com Inc.</p>
      <p>NIKE, Inc.</p>
      <p>Oracle Corporation</p>
      <p>Salesforce, Inc.</p>
    ${FOOT}`;
    const groups = extractPeerGroupsFromSuffixEnumeration("dedupe", html);
    expect(groups).toHaveLength(1);
    const aaplCount = groups[0].members.filter(
      (m) => m.ticker_resolved === "AAPL",
    ).length;
    expect(aaplCount).toBe(1);
  });
});
