/**
 * Shared in-memory cache for SEC's company_tickers.json. The file is
 * about 600 KB, ~13,000 entries, refreshed by SEC daily. Loading it
 * once per cold start and caching for 6 hours is plenty for autocomplete
 * latency without exhausting the SEC rate budget on keystrokes.
 *
 * The same cache backs the ingest service's identifier resolution —
 * one fetch covers both surfaces.
 *
 * Phase 19: when the live SEC fetch fails (Vercel data-transfer quota,
 * SEC outage, network error) the loader falls back to the bundled
 * .fixtures/ticker_map.json that already ships with the build for the
 * peer-group extractor. The fallback cache is marked `source: "bundled"`
 * so callers can render a degraded-but-functional UI instead of a 502.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  /** "live" if loaded from SEC, "bundled" if from the static fallback. */
  source: "live" | "bundled";
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BUNDLED_TTL_MS = 5 * 60 * 1000; // shorter — keep trying live
let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

interface RawEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface BundledEntry {
  cik?: string;
  cik_str?: number | string;
  ticker?: string;
  title?: string;
  name?: string;
}

function buildCache(entries: SecTickerEntry[], source: "live" | "bundled"): Cache {
  const byTickerLower = new Map<string, SecTickerEntry>();
  const byCik = new Map<string, SecTickerEntry>();
  for (const e of entries) {
    byTickerLower.set(e.ticker_lower, e);
    byCik.set(e.cik, e);
  }
  return { entries, byTickerLower, byCik, loadedAt: Date.now(), source };
}

async function loadLive(): Promise<Cache> {
  const sec = new SecClient();
  const raw = await sec.fetchJson<Record<string, RawEntry>>(
    "https://www.sec.gov/files/company_tickers.json",
  );
  const entries: SecTickerEntry[] = [];
  for (const r of Object.values(raw)) {
    if (!r?.ticker || !r.title) continue;
    const ticker = r.ticker;
    const cik = String(r.cik_str).padStart(10, "0");
    entries.push({
      cik,
      ticker,
      ticker_lower: ticker.toLowerCase(),
      name: r.title,
      name_lower: r.title.toLowerCase(),
    });
  }
  return buildCache(entries, "live");
}

function loadBundled(): Cache | null {
  const path = join(process.cwd(), ".fixtures", "ticker_map.json");
  if (!existsSync(path)) return null;
  let raw: Record<string, BundledEntry>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  const entries: SecTickerEntry[] = [];
  for (const r of Object.values(raw)) {
    const ticker = r.ticker?.trim();
    const title = (r.title ?? r.name)?.trim();
    if (!ticker || !title) continue;
    const cikRaw = r.cik ?? r.cik_str;
    if (cikRaw === undefined || cikRaw === null) continue;
    const cik = String(cikRaw).padStart(10, "0");
    entries.push({
      cik,
      ticker,
      ticker_lower: ticker.toLowerCase(),
      name: title,
      name_lower: title.toLowerCase(),
    });
  }
  if (entries.length === 0) return null;
  return buildCache(entries, "bundled");
}

/**
 * Returns the cached SEC ticker universe.
 *
 * If a live cache is fresh, returns it. Otherwise tries to load live;
 * on failure (Vercel data-transfer quota, network error, SEC outage),
 * falls back to the bundled ticker_map.json. Throws ONLY if both
 * fail — autocomplete should treat throws as "no SEC universe
 * available" but should still surface any imported DB matches.
 */
export async function getSecTickers(): Promise<Cache> {
  if (cache) {
    const ttl = cache.source === "live" ? CACHE_TTL_MS : BUNDLED_TTL_MS;
    if (Date.now() - cache.loadedAt < ttl) return cache;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await loadLive();
      cache = fresh;
      return fresh;
    } catch (err) {
      const bundled = loadBundled();
      if (bundled) {
        console.warn(
          "[sec-tickers] live fetch failed, using bundled fallback:",
          err instanceof Error ? err.message : err,
        );
        cache = bundled;
        return bundled;
      }
      throw err;
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
export function _seedSecTickersCacheForTests(
  entries: SecTickerEntry[],
  source: "live" | "bundled" = "live",
): void {
  cache = buildCache(entries, source);
}

/** Test-only: load from the bundled fallback synchronously. */
export function _loadBundledForTests(): Cache | null {
  return loadBundled();
}
