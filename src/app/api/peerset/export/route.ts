/**
 * Peer-set CSV export.
 *
 *   GET /api/peerset/export?companies=aapl,msft,googl
 *
 * Builds the same wide-format CSV the compare-page button produces,
 * but with no ≤6 cap — the peer set itself is what bounds the column
 * count. Companies that aren't in the DB are emitted as a placeholder
 * row marked `In ProxyMiner DB,no` so the analyst can see at a glance
 * which peers still need importing.
 *
 * Public — no auth. Anyone with a list of tickers can pull the CSV.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  getCompany,
  getFilingDetail,
  getLatestFiling,
  listFilings,
} from "@/lib/data/source";
import { buildPeerSetCsv } from "@/lib/peer-set/csv";
import {
  buildColumnPayload,
  notIngestedPayload,
  type ColumnPayload,
} from "@/lib/peer-set/csv-payload";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_COMPANIES = 30;
const TICKER_PATTERN = /^[a-z][a-z0-9.\-]{0,7}$/i;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("companies") ?? "").trim();
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && TICKER_PATTERN.test(s))
    .slice(0, MAX_COMPANIES);

  if (ids.length === 0) {
    return NextResponse.json(
      {
        error: "no_companies",
        message:
          "Pass ?companies=<comma-separated-tickers>. Each ticker is 1-8 chars (letters/digits/./-).",
      },
      { status: 400 },
    );
  }

  // Resolve each id into a ColumnPayload. Concurrent; bounded by the
  // 30-company cap above so we don't fan-out unbounded queries.
  const columns: ColumnPayload[] = await Promise.all(
    ids.map(async (id) => {
      try {
        const company = await getCompany(id);
        if (!company) return notIngestedPayload(id);
        // Prefer the latest filing detail; fall back via listFilings
        // for companies whose getLatestFiling somehow returns null.
        let filing = await getLatestFiling(id);
        if (!filing) {
          const list = await listFilings(id);
          if (list.length > 0) {
            filing = await getFilingDetail(list[0].id);
          }
        }
        return buildColumnPayload(company, filing);
      } catch (err) {
        console.warn(`[peerset/export] failed to resolve ${id}:`, err);
        return notIngestedPayload(id);
      }
    }),
  );

  const csv = buildPeerSetCsv(columns);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `proxyminer-peer-set-${ids.join("-")}-${stamp}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // No cache: the underlying company data can change (re-ingest,
      // committee-reviewed cells), and the CSV is the analyst's
      // snapshot at click time.
      "cache-control": "no-store",
    },
  });
}
