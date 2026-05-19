/**
 * Regression tests for the single-token alias blocklist and the
 * lowercase-noise post-extraction guard added in Phase 8.
 *
 * The fix lives in two layers:
 *   1. `aliasesForName` no longer emits common single-word English
 *      tokens as standalone aliases (so they never enter the resolver
 *      index in the first place).
 *   2. `extractPeerGroups` filters out members whose raw name is a
 *      bare lowercase single token (defensive second line).
 *
 * Tests below pin the first layer via the public `resolveCompanyName`
 * helper, which exercises the same resolver, and the second layer via
 * `extractPeerGroups` with a real shape the extractor handles.
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroups, resolveCompanyName } from "./peer-groups";

describe("resolveCompanyName — single-token alias blocklist", () => {
  it.each([
    "works",
    "market",
    "network",
    "acquisition",
    "industries",
    "services",
    "systems",
    "technology",
    "media",
    "energy",
    "brands",
    "platforms",
    "communications",
    "equipment",
    "engineering",
    "smith",
    "mobile",
    "motors",
    "foods",
    "stores",
    "international",
    "global",
    "growth",
  ])("'%s' alone does NOT resolve to a SEC company", (token) => {
    // Pre-fix: each of these resolved to *some* SEC company via a
    // single-significant-token alias ("Bath & Body Works" → "works",
    // "Smith Micro" → "smith", etc.). After the blocklist they
    // shouldn't resolve at all.
    const result = resolveCompanyName(token);
    expect(result.resolved_name, `expected '${token}' unresolved`).toBeNull();
  });

  it("full multi-word names still resolve normally", () => {
    expect(resolveCompanyName("Apple Inc.").ticker).toBe("AAPL");
    expect(resolveCompanyName("Microsoft Corp").ticker).toBe("MSFT");
    expect(resolveCompanyName("Salesforce, Inc.").ticker).toBe("CRM");
  });

  it("stripped single-word names still resolve when distinctive", () => {
    // "Apple" / "Microsoft" / "Salesforce" are the canonical
    // single-word names that survive the blocklist (they're not
    // common English nouns). Each is added by `significantTokens` as
    // its single significant token; the blocklist only blocks
    // generic words like "works" / "market".
    expect(resolveCompanyName("Microsoft").ticker).toBe("MSFT");
    expect(resolveCompanyName("Salesforce").ticker).toBe("CRM");
  });
});

describe("extractPeerGroups — lowercase-noise post-guard", () => {
  it("rejects members whose raw name is a single lowercase token", () => {
    // Use a known-good CD&A shape so the extractor finds a group,
    // then verify the post-guard suppresses any lowercase singletons
    // that managed to slip through.
    const cda = `
In the second quarter of 2024, the compensation committee approved
the following companies for inclusion in our Peer Group for 2025:

Peer GroupAlphabet (GOOG, GOOGL)NVIDIA (NVDA)Amazon.com (AMZN)Oracle (ORCL)Apple (AAPL)salesforce.com (CRM)AT&T (T)The Walt Disney Company (DIS)Cisco Systems (CSCO)Microsoft (MSFT)
    `.trim();
    const groups = extractPeerGroups("test-noise-1", cda);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const flat = groups.flatMap((g) =>
      g.members.map((m) => m.company_name_raw),
    );
    // No single lowercase tokens anywhere in the output.
    const lowercaseSingletons = flat.filter(
      (n) => !n.includes(" ") && !/[A-Z]/.test(n),
    );
    expect(lowercaseSingletons).toEqual([]);
  });

  it("preserves real multi-word peers", () => {
    const cda = `
In the second quarter of 2024, the compensation committee approved
the following companies for inclusion in our Peer Group for 2025:

Peer GroupAlphabet (GOOG, GOOGL)NVIDIA (NVDA)Amazon.com (AMZN)Oracle (ORCL)Apple (AAPL)salesforce.com (CRM)AT&T (T)The Walt Disney Company (DIS)Cisco Systems (CSCO)Microsoft (MSFT)
    `.trim();
    const groups = extractPeerGroups("test-noise-2", cda);
    const tickers = groups
      .flatMap((g) => g.members)
      .map((m) => m.ticker_resolved)
      .filter(Boolean);
    // We should see several of the named tickers.
    const expected = ["AAPL", "MSFT", "GOOGL", "NVDA", "AMZN"];
    const hits = expected.filter((t) => tickers.includes(t));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
