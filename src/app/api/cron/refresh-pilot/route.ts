/**
 * Vercel Cron handler. Weekly refresh of the pilot cohort.
 *
 * Vercel signs cron requests with `x-vercel-cron`. We additionally
 * gate via the admin token so an attacker can't trigger backfills by
 * spoofing the cron header.
 */
import { NextRequest, NextResponse } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";

export const runtime = "nodejs";
export const maxDuration = 300;

const PILOT_TICKERS = [
  "AAPL", "MSFT", "META", "GOOGL", "AMZN", "NVDA",
  "ORCL", "CRM", "NFLX", "QCOM", "ADBE", "AVGO",
];

export async function GET(req: NextRequest) {
  const expected = process.env.PROXYMINER_ADMIN_API_TOKEN;
  const auth = req.headers.get("authorization") ?? "";
  const isCron = req.headers.get("x-vercel-cron") === "1";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!isCron && (!expected || provided !== expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};
  for (const ticker of PILOT_TICKERS) {
    try {
      results[ticker] = await ingestCompany(ticker, { limit: 1 });
    } catch (err) {
      results[ticker] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({ ok: true, results });
}
