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

  // Phase 11 expansion: each of these caused a production false
  // positive on SPG / INTC / KEY / DXCM, where the bare word in CD&A
  // prose matched an unrelated SEC company via single-token alias.
  it.each([
    "below",          // Five Below, Inc.
    "above",          // Above Food Ingredients Inc.
    "tower",          // American Tower Corp
    "estate",         // Lead Real Estate
    "castle",         // Castle Biosciences
    "realty",         // Realty Income (when prose says bare "realty")
    "investment",     // AGNC Investment Corp
    "investments",    // SEI Investments
    "payments",       // Global Payments
    "performance",    // Performance Food Group
    "regional",       // (regional-bank false matches)
    "institutions",   // Financial Institutions Inc
    "universal",      // Universal Health Services
    "business",       // Business First Bancshares
    "strategic",      // Strategic-Asset-Resource matches
    "greater",        // Greater Cannabis Company
    "leaders",        // Global Leaders
    "focus",          // Focus Financial
    "ingredients",
    "pharmaceutical",
    "match",          // Match Group
    "perfect",        // Perfect Corp
    "pool",           // Pool Corp
    "discovery",
    "twelve",         // SPAC names
    "range",          // Range Resources
    "times",          // New York Times
    "wave",           // Wave Life Sciences
    "ebay",           // eBay Inc — bare "ebay" in prose
    "gap",            // Gap Inc — bare "gap"
    "income",         // Realty Income / generic prose
    "center",         "centers",
    "street",         // Main Street Capital
    "information",    // CASS Information Systems
    "devices",        // generic device prose
    // Phase 11.5: residual false positives surfaced by post-reingest
    // cohort sweep (O, ZTS, TMO, ROK).
    "table",          // TBTC Table Trac — "Summary Compensation Table"
    "total",          // STEW SRH Total Return Fund
    "equity",         // EQR Equity Residential — "equity" in proxy prose
    "short",          // SDHY Short Duration High Yield Fund
    "paid",           // PAYD Paid Inc
    "light",          // OHCFF Light AI Inc
    "engagement",     // BNAI — "stockholder engagement"
    "trading",        // HEPS D-MARKET ... Trading
    "relevant",       // RGCCF Relevant Gold Corp
    "laboratories",   // BIO Bio-Rad Laboratories
    "beyond",         // BYND Beyond Meat
    "alignment",
    "benchmark",
    "various",
    "alternative",
  ])(
    "Phase 11: '%s' alone does NOT resolve to a SEC company",
    (token) => {
      const result = resolveCompanyName(token);
      expect(result.resolved_name, `'${token}' should be blocked`).toBeNull();
    },
  );

  it("5-char common English nouns no longer create single-token aliases", () => {
    // Phase 11.5 algorithmic guard: significantTokens single-token
    // path now requires length >= 6, blocking "below", "table",
    // "short" etc. even before COMMON_NAME_WORDS lookup.
    expect(resolveCompanyName("below").resolved_name).toBeNull();
    expect(resolveCompanyName("table").resolved_name).toBeNull();
    expect(resolveCompanyName("short").resolved_name).toBeNull();
  });

  // Phase 16 fourth-pass blocklist additions surfaced after Phase 15
  // cohort expansion: 8+ char common English words that survived the
  // length cutoff and weren't yet in COMMON_NAME_WORDS.
  it.each([
    "independent",  // INDB Independent Bank Corp — "independent committee"
    "effective",    // SFWJ Software Effective Solutions
    "consumer",     // PMVC — generic consumer-prose match
    "consulting",   // FCN — generic prose
    "opportunities", // KIO KKR Income Opportunities Fund
    "limited",      // EBOSY — corporate suffix used as token
  ])(
    "Phase 16: '%s' alone does NOT resolve to a SEC company",
    (token) => {
      const result = resolveCompanyName(token);
      expect(result.resolved_name, `'${token}' should be blocked`).toBeNull();
    },
  );

  it("Phase 16: multi-word aliases of all-blocklisted phrases do not resolve", () => {
    // The stripped-name path can produce phrases like "financial
    // institutions" (FISI) where every token is in the blocklist. The
    // multi-word guard rejects these — the phrase is a generic noun
    // phrase ("financial institutions in our benchmark group") and
    // shouldn't false-match the SEC company.
    expect(resolveCompanyName("financial institutions").resolved_name).toBeNull();
    // The full alias with corporate suffix may still match in rare
    // exact-phrase contexts; the guard only suppresses the bare
    // multi-word form.
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
