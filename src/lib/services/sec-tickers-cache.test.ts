/**
 * Phase 19 — fallback paths for the SEC ticker cache.
 *
 * Production observed Vercel "data transfer quota exceeded" errors
 * from the SEC fetch. Before Phase 19 this propagated as a 502 from
 * /api/search/ticker, which the homepage misreported as "No SEC
 * company matches". The cache now falls back to the bundled
 * .fixtures/ticker_map.json file so the search universe stays useful.
 *
 * These tests pin:
 *   - bundled fallback returns >5000 entries
 *   - NVDA / AAPL / MSFT all resolvable via the bundled fallback
 *   - cache `source` field correctly flags "live" vs "bundled"
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _loadBundledForTests,
  _resetSecTickersCacheForTests,
  _seedSecTickersCacheForTests,
  getSecTickers,
  type SecTickerEntry,
} from "./sec-tickers-cache";

afterEach(() => {
  _resetSecTickersCacheForTests();
  vi.restoreAllMocks();
});

describe("getSecTickers — bundled fallback (Phase 19)", () => {
  it("loadBundled() returns the bundled .fixtures/ticker_map.json", () => {
    const bundled = _loadBundledForTests();
    expect(bundled).not.toBeNull();
    expect(bundled!.source).toBe("bundled");
    expect(bundled!.entries.length).toBeGreaterThan(5000);
  });

  it.each(["NVDA", "AAPL", "MSFT", "GOOGL", "META"])(
    "bundled fallback resolves %s by ticker",
    (ticker) => {
      const bundled = _loadBundledForTests();
      expect(bundled).not.toBeNull();
      const hit = bundled!.byTickerLower.get(ticker.toLowerCase());
      expect(hit, `expected ${ticker} in bundled map`).toBeDefined();
      expect(hit!.ticker).toBe(ticker);
      expect(hit!.name.length).toBeGreaterThan(0);
    },
  );

  it("getSecTickers falls back to bundled when live fetch throws", async () => {
    _resetSecTickersCacheForTests();
    // Mock global fetch to simulate Vercel quota error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "fetch_failed",
          message: "Your project has exceeded the data transfer quota.",
        }),
        { status: 503 },
      ),
    ) as typeof fetch;

    try {
      const result = await getSecTickers();
      expect(result.source).toBe("bundled");
      expect(result.entries.length).toBeGreaterThan(5000);
      // NVDA must be present in the fallback dataset
      expect(result.byTickerLower.get("nvda")).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("seeded live cache is preferred over bundled fallback", async () => {
    const synth: SecTickerEntry[] = [
      {
        cik: "0000000001",
        ticker: "FAKE",
        ticker_lower: "fake",
        name: "FAKE LIVE CO",
        name_lower: "fake live co",
      },
    ];
    _seedSecTickersCacheForTests(synth, "live");
    const result = await getSecTickers();
    expect(result.source).toBe("live");
    expect(result.entries).toHaveLength(1);
    expect(result.byTickerLower.get("fake")?.name).toBe("FAKE LIVE CO");
  });
});
