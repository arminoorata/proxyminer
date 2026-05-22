/**
 * Public read-only enumeration of every company in ProxyMiner.
 *
 *   GET /api/cohort
 *   → { count: number, companies: Array<{ company_id, ticker, name, sector }> }
 *
 * Used by scripts/audit-peer-panels.mjs to discover the authoritative
 * cohort list without relying on autocomplete's top-20 ranking (which
 * can miss companies whose 2-letter prefix has >20 SEC tickers ahead
 * of them — e.g. CMCSA at rank >20 for `q=cm`).
 *
 * Same listCompanies() source as the autocomplete uses for its
 * in_db flag, so audit results stay consistent with what users see.
 * No auth required — same surface area as the company pages.
 */
import { NextResponse } from "next/server";

import { listCompanies } from "@/lib/data/source";

export const runtime = "nodejs";

export async function GET() {
  let rows;
  try {
    rows = await listCompanies();
  } catch (err) {
    return NextResponse.json(
      {
        error: "db_unavailable",
        message: err instanceof Error ? err.message : "listCompanies failed",
      },
      { status: 503 },
    );
  }

  const companies = rows
    .map((c) => ({
      company_id: c.id,
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
    }))
    .sort((a, b) => (a.ticker ?? a.company_id).localeCompare(b.ticker ?? b.company_id));

  return NextResponse.json(
    { count: companies.length, companies },
    {
      headers: {
        // Cohort changes only on admin ingest; the audit can tolerate
        // a brief cache while still seeing every commit.
        "cache-control": "public, max-age=60",
      },
    },
  );
}
