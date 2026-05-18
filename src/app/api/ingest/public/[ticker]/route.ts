/**
 * Public on-demand ingest. No admin token. Anyone can POST to import
 * the latest two DEF 14A proxies for a ticker that isn't already in
 * the database.
 *
 *   POST /api/ingest/public/AAPL
 *   → 200 {ok:true, company_id:"aapl", filings_processed:2, ...}
 *   → 200 {ok:true, status:"already_ingested", company_id:"aapl"} (≤10 min)
 *   → 400 {error:"invalid_ticker", ...}
 *   → 404 {error:"not_in_sec_tickers", ...}
 *   → 429 {error:"client_cap"|"in_flight", ...}
 *   → 502 {error:"sec_fetch_failed", ...}
 *   → 503 {error:"db_unavailable", ...}
 *
 * Protections (see public-ingest-gate.ts):
 *   - same ticker within last 10 min → already_ingested
 *   - hashed-client cap of 5/hour    → client_cap
 *   - ticker shape gate (1-6 chars, alnum + .)
 *
 * Why not just expose /api/admin/ingest publicly: the admin route uses
 * a Bearer token for a reason — it can take any identifier and runs
 * with no per-client cap. The public path is the same engine with
 * tight guards.
 */
import { NextRequest, NextResponse } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";
import {
  checkRateGate,
  extractClientIp,
  hashClient,
} from "@/lib/services/public-ingest-gate";
import { isValidTickerShape } from "@/lib/services/ticker-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "db_unavailable", message: "Postgres not configured" },
      { status: 503 },
    );
  }

  const { ticker } = await params;
  const cleaned = (ticker ?? "").trim();
  if (!isValidTickerShape(cleaned)) {
    return NextResponse.json(
      {
        error: "invalid_ticker",
        message:
          "Ticker must be 1–8 characters and may contain letters, digits, '.', or '-'.",
      },
      { status: 400 },
    );
  }

  const clientHash = hashClient(extractClientIp(req.headers));
  let gate;
  try {
    gate = await checkRateGate(cleaned, clientHash);
  } catch (err) {
    return NextResponse.json(
      {
        error: "rate_gate_failed",
        message: err instanceof Error ? err.message : "rate gate failed",
      },
      { status: 500 },
    );
  }
  if (!gate.allowed) {
    if (gate.reason === "already_ingested" || gate.reason === "in_flight") {
      // Return the resolved company_id by trying a best-effort lookup so
      // the front-end can redirect straight to /company/<id>.
      const companyId = cleaned.toLowerCase();
      return NextResponse.json(
        {
          ok: true,
          status: gate.reason,
          company_id: companyId,
          recent_job_id: gate.recent_job_id ?? null,
          message:
            gate.reason === "in_flight"
              ? "An import for this ticker is already running. Try again in a moment."
              : "Already imported in the last 10 minutes. Showing existing record.",
        },
        { status: 200 },
      );
    }
    if (gate.reason === "client_cap") {
      return NextResponse.json(
        {
          error: "client_cap",
          message:
            "You've imported 5 companies in the last hour. Try again later.",
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "rate_limited", message: "Please try again later." },
      { status: 429 },
    );
  }

  try {
    const result = await ingestCompany(cleaned, {
      limit: 2,
      audit: { job_type: "public_ingest", client_hash: clientHash },
    });

    if (result.filings_processed === 0 && result.errors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "ingest_failed",
          company_id: result.company_id,
          errors: result.errors,
          message:
            "Resolved the ticker but couldn't extract any DEF 14A filings. Try a different ticker or report this.",
        },
        { status: 502 },
      );
    }

    if (result.filings_processed === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "no_proxy_found",
          company_id: result.company_id,
          message:
            "SEC has no DEF 14A proxy filings on file for this ticker. ProxyMiner only covers proxies, not 10-K/10-Q.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: "ingested",
      company_id: result.company_id,
      filings_processed: result.filings_processed,
      errors: result.errors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("could not resolve identifier")) {
      return NextResponse.json(
        {
          error: "not_in_sec_tickers",
          message:
            "SEC EDGAR doesn't list a company with this ticker. Check the spelling and try again.",
        },
        { status: 404 },
      );
    }
    if (msg.startsWith("SEC fetch failed")) {
      return NextResponse.json(
        { error: "sec_fetch_failed", message: msg },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "ingest_failed", message: msg },
      { status: 500 },
    );
  }
}
