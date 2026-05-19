/**
 * Shared in-memory cache for SEC's company_tickers.json. The file is
 * about 600 KB, ~13,000 entries, refreshed by SEC daily. Loading it
 * once per cold start and caching for 6 hours is plenty for autocomplete
 * latency without exhausting the SEC rate budget on keystrokes.
 *
 * The same cache backs the ingest service's identifier resolution —
 * one fetch covers both surfaces.
 */
import { SecClient } from "@/lib/extractors/sec-client";

export interface SecTickerEntry {
  cik: string;             // padded to 10 chars, ready for SEC URLs
  ticker: string;          // upper-case, as SEC lists it
  ticker_lower: string;    // pre-lowercased, hot-path comparisons
  name: string;            // SEC's "title" field
  name_lower: string;      // pre-lowercased
}

interface Cache {
  entries: SecTickerEntry[];
  byTickerLower: Map<string, SecTickerEntry>;
  byCik: Map<string, SecTickerEntry>;
  loadedAt: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

interface RawEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

async function load(): Promise<Cache> {
  const sec = new SecClient();
  const raw = await sec.fetchJson<Record<string, RawEntry>>(
    "https://www.sec.gov/files/company_tickers.json",
  );
  const entries: SecTickerEntry[] = [];
  const byTickerLower = new Map<string, SecTickerEntry>();
  const byCik = new Map<string, SecTickerEntry>();
  for (const r of Object.values(raw)) {
    if (!r?.ticker || !r.title) continue;
    const ticker = r.ticker;
    const cik = String(r.cik_str).padStart(10, "0");
    const entry: SecTickerEntry = {
      cik,
      ticker,
      ticker_lower: ticker.toLowerCase(),
      name: r.title,
      name_lower: r.title.toLowerCase(),
    };
    entries.push(entry);
    byTickerLower.set(entry.ticker_lower, entry);
    byCik.set(cik, entry);
  }
  return { entries, byTickerLower, byCik, loadedAt: Date.now() };
}

/** Returns the cached SEC ticker universe, refreshing if past TTL. */
export async function getSecTickers(): Promise<Cache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await load();
      cache = fresh;
      return fresh;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test-only: wipe the cache. Production code should never call this. */
export function _resetSecTickersCacheForTests(): void {
  cache = null;
  inflight = null;
}

/** Test-only: seed the cache directly without a network call. */
export function _seedSecTickersCacheForTests(entries: SecTickerEntry[]): void {
  const byTickerLower = new Map<string, SecTickerEntry>();
  const byCik = new Map<string, SecTickerEntry>();
  for (const e of entries) {
    byTickerLower.set(e.ticker_lower, e);
    byCik.set(e.cik, e);
  }
  cache = { entries, byTickerLower, byCik, loadedAt: Date.now() };
}
