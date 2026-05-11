/**
 * Vercel Cron handler. Weekly refresh of the pilot cohort, chunked
 * to fit Hobby tier's 60s function cap. Three schedules in
 * `vercel.json` hit this same path with `?chunk=0|1|2`, each
 * processing 4 tickers (~20–40s observed). A request without a chunk
 * param falls back to all 12 tickers — used by manual curl in dev.
 *
 * Vercel cron requests can be secured by setting CRON_SECRET, which
 * Vercel sends as `Authorization: Bearer <CRON_SECRET>`. Manual runs
 * may use the admin token. Do not trust `x-vercel-cron` alone because
 * external callers can send custom headers with curl.
 */
import { NextRequest, NextResponse } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";

export const runtime = "nodejs";
export const maxDuration = 60;

// Pilot cohort: 12 mega-cap tech filers. Heavily tested.
const PILOT_TICKERS = [
  "AAPL", "MSFT", "META", "GOOGL",
  "AMZN", "NVDA", "ORCL", "CRM",
  "NFLX", "QCOM", "ADBE", "AVGO",
];
// Long-tail cohort: deliberately picks proxy formats outside mega-cap
// tech so the extractor can be validated on sector/size diversity:
//   - KEY  : KeyCorp (regional bank, financials sector)
//   - O    : Realty Income (REIT, monthly-dividend filer)
//   - AYI  : Acuity Brands (small-cap industrial, fiscal Aug year-end)
//   - IDXX : IDEXX Laboratories (mid-cap healthcare/diagnostics)
//   - WMT  : Walmart (mega-cap retail, distinct from tech filers)
const LONG_TAIL_TICKERS = ["KEY", "O", "AYI", "IDXX", "WMT"];
const ALL_TICKERS = [...PILOT_TICKERS, ...LONG_TAIL_TICKERS];
const CHUNK_SIZE = 4;

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasValidBearer(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided) return false;
  const accepted = [
    process.env.CRON_SECRET,
    process.env.PROXYMINER_ADMIN_API_TOKEN,
  ].filter((v): v is string => Boolean(v));
  return accepted.some((expected) => timingSafeEq(provided, expected));
}

export async function GET(req: NextRequest) {
  if (!hasValidBearer(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const chunkRaw = url.searchParams.get("chunk");
  // ?cohort=pilot (default, mega-cap tech only — preserves prior cron
  // behavior) or ?cohort=all (pilot + long-tail) or ?cohort=long-tail.
  const cohort = (url.searchParams.get("cohort") ?? "pilot").toLowerCase();
  const pool =
    cohort === "all" ? ALL_TICKERS : cohort === "long-tail" ? LONG_TAIL_TICKERS : PILOT_TICKERS;
  let tickers: string[];
  if (chunkRaw === null) {
    tickers = pool;
  } else {
    const chunk = Number.parseInt(chunkRaw, 10);
    if (!Number.isInteger(chunk) || chunk < 0) {
      return NextResponse.json({ error: "invalid chunk" }, { status: 400 });
    }
    const start = chunk * CHUNK_SIZE;
    if (start >= pool.length) {
      return NextResponse.json({ ok: true, chunk, results: {} });
    }
    tickers = pool.slice(start, start + CHUNK_SIZE);
  }

  const results: Record<string, unknown> = {};
  for (const ticker of tickers) {
    try {
      results[ticker] = await ingestCompany(ticker, { limit: 1 });
    } catch (err) {
      results[ticker] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({ ok: true, chunk: chunkRaw, results });
}
