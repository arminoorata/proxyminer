/**
 * Vercel Cron handler. Weekly refresh of the pilot cohort, chunked
 * to fit Hobby tier's 60s function cap. Three schedules in
 * `vercel.json` hit this same path with `?chunk=0|1|2`, each
 * processing 4 tickers (~20–40s observed). A request without a chunk
 * param falls back to all 12 tickers — used by manual curl in dev.
 *
 * Vercel signs cron requests with `x-vercel-cron`. We additionally
 * gate via the admin token so an attacker can't trigger backfills by
 * spoofing the cron header.
 */
import { NextRequest, NextResponse } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const PILOT_TICKERS = [
  "AAPL", "MSFT", "META", "GOOGL",
  "AMZN", "NVDA", "ORCL", "CRM",
  "NFLX", "QCOM", "ADBE", "AVGO",
];
const CHUNK_SIZE = 4;

export async function GET(req: NextRequest) {
  const expected = process.env.PROXYMINER_ADMIN_API_TOKEN;
  const auth = req.headers.get("authorization") ?? "";
  const isCron = req.headers.get("x-vercel-cron") === "1";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!isCron && (!expected || provided !== expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const chunkRaw = url.searchParams.get("chunk");
  let tickers: string[];
  if (chunkRaw === null) {
    tickers = PILOT_TICKERS;
  } else {
    const chunk = Number.parseInt(chunkRaw, 10);
    if (!Number.isInteger(chunk) || chunk < 0) {
      return NextResponse.json({ error: "invalid chunk" }, { status: 400 });
    }
    const start = chunk * CHUNK_SIZE;
    if (start >= PILOT_TICKERS.length) {
      return NextResponse.json({ ok: true, chunk, results: {} });
    }
    tickers = PILOT_TICKERS.slice(start, start + CHUNK_SIZE);
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
