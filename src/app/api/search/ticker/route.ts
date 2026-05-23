/**
 * Autocomplete search across the SEC ticker universe.
 *
 *   GET /api/search/ticker?q=appl&limit=10
 *
 * Returns ranked hits over SEC's ~13k tickers, each annotated with
 * whether the company is already in ProxyMiner's DB. The front-end
 * routes "in_db: true" hits straight to /company/[id] and the rest
 * to /import/[ticker].
 *
 * No auth — anyone can type. The SEC ticker file is fetched once per
 * cold start and cached for 6 hours, so per-keystroke load is purely
 * an in-memory filter.
 */
import { NextRequest, NextResponse } from "next/server";

import { listCompanies } from "@/lib/data/source";
import { getSecTickers } from "@/lib/services/sec-tickers-cache";
import { searchTickers } from "@/lib/services/ticker-search";

export const runtime = "nodejs";

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  if (q.length < 1) {
    return NextResponse.json({ items: [], total: 0, q });
  }

  // Companies already imported — small list (~82 today), cheap to
  // fetch + Set-build per request.
  let importedCompanies: { id: string; name: string; ticker: string | null }[] = [];
  let importedIds: Set<string>;
  try {
    const rows = await listCompanies();
    importedCompanies = rows.map((c) => ({ id: c.id, name: c.name, ticker: c.ticker }));
    importedIds = new Set(rows.map((c) => c.id));
  } catch (err) {
    // If DB is down we still want autocomplete; just mark everything
    // as not-in-db rather than 500.
    console.warn("[search/ticker] listCompanies failed:", err);
    importedIds = new Set();
  }

  // Phase 19: the SEC ticker fetch can fail (Vercel data-transfer
  // quota, SEC outage, network). getSecTickers() now falls back to
  // the bundled .fixtures/ticker_map.json automatically; if even
  // that fails, we still want to return any imported-DB matches
  // rather than a 502 — autocomplete must not blank the dropdown.
  let cache;
  let source: "live" | "bundled" | "db-only" = "live";
  try {
    cache = await getSecTickers();
    source = cache.source;
  } catch (err) {
    console.warn("[search/ticker] getSecTickers (incl. bundled fallback) failed:", err);
    cache = null;
    source = "db-only";
  }

  let items: Array<{
    ticker: string;
    name: string;
    cik: string | null;
    in_db: boolean;
    company_id: string;
    match_reason: string;
  }>;

  if (cache) {
    const hits = searchTickers(q, cache.entries, importedIds, { limit });
    items = hits.map((h) => ({
      ticker: h.ticker,
      name: h.name,
      cik: h.cik,
      in_db: h.in_db,
      company_id: h.company_id,
      match_reason: h.match_reason,
    }));
  } else {
    // Last resort: filter only imported companies by ticker / name.
    const qLower = q.toLowerCase();
    items = importedCompanies
      .filter((c) => {
        const t = (c.ticker ?? "").toLowerCase();
        const n = c.name.toLowerCase();
        return t.startsWith(qLower) || n.includes(qLower);
      })
      .slice(0, limit)
      .map((c) => ({
        ticker: c.ticker ?? c.id.toUpperCase(),
        name: c.name,
        cik: null,
        in_db: true,
        company_id: c.id,
        match_reason: t_or_name_match(c, qLower),
      }));
  }

  return NextResponse.json(
    {
      items,
      total: items.length,
      q,
      source,
      degraded: source !== "live",
    },
    {
      headers: {
        // Each query is cheap on the server (in-memory filter) and
        // identical responses can be reused across users for a short
        // window. Short TTL keeps newly-imported companies surfacing
        // as "in_db: true" promptly. Use a shorter TTL when degraded
        // so a recovery is picked up promptly.
        "cache-control":
          source === "live"
            ? "public, max-age=30"
            : "public, max-age=10",
      },
    },
  );
}

function t_or_name_match(
  c: { id: string; name: string; ticker: string | null },
  qLower: string,
): string {
  const t = (c.ticker ?? "").toLowerCase();
  if (t === qLower) return "ticker_exact";
  if (t.startsWith(qLower)) return "ticker_prefix";
  return "name_substring";
}
