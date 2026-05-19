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

  // Companies already imported — small list (~37 today), cheap to
  // fetch + Set-build per request.
  let importedIds: Set<string>;
  try {
    const rows = await listCompanies();
    importedIds = new Set(rows.map((c) => c.id));
  } catch (err) {
    // If DB is down we still want autocomplete; just mark everything
    // as not-in-db rather than 500.
    console.warn("[search/ticker] listCompanies failed:", err);
    importedIds = new Set();
  }

  let cache;
  try {
    cache = await getSecTickers();
  } catch (err) {
    return NextResponse.json(
      {
        error: "sec_unavailable",
        message: err instanceof Error ? err.message : "SEC ticker feed unavailable",
      },
      { status: 502 },
    );
  }

  const hits = searchTickers(q, cache.entries, importedIds, { limit });
  // Project a public payload — never expose the raw ranking score.
  const items = hits.map((h) => ({
    ticker: h.ticker,
    name: h.name,
    cik: h.cik,
    in_db: h.in_db,
    company_id: h.company_id,
    match_reason: h.match_reason,
  }));

  return NextResponse.json(
    {
      items,
      total: items.length,
      q,
    },
    {
      headers: {
        // Each query is cheap on the server (in-memory filter) and
        // identical responses can be reused across users for a short
        // window. Short TTL keeps newly-imported companies surfacing
        // as "in_db: true" promptly.
        "cache-control": "public, max-age=30",
      },
    },
  );
}
