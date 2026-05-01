/**
 * Admin ingest route — kicks off ingestion for a single ticker / CIK.
 *
 *   POST /api/admin/ingest/AAPL?limit=2
 *   Authorization: Bearer <PROXYMINER_ADMIN_API_TOKEN>
 *
 * Implementation: per-call SEC fetches happen serially with the
 * Postgres-backed rate budgeter. Per-filing extraction calls the
 * Phase-4 TS extractors and persists via Drizzle. Long backfills
 * should use the workflow handler (see /api/workflow/ingest) so they
 * can chunk past the function timeout.
 */
import { NextRequest, NextResponse } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> },
) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  const { identifier } = await params;
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "2", 10);

  try {
    const result = await ingestCompany(identifier, {
      limit: Number.isFinite(limit) ? limit : 2,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ingest failed" },
      { status: 500 },
    );
  }
}
