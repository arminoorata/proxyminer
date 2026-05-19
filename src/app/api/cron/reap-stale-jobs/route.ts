/**
 * Stale-job reaper. Marks any ingest_jobs row that's been stuck in an
 * in-flight phase (queued/resolving/fetching/extracting/saving) for
 * longer than the reap threshold as `failed`, with completed_at set
 * to now. This frees up the dedupe gate for retries and keeps the
 * audit trail honest about jobs the `after()` worker abandoned.
 *
 * Auth: Bearer CRON_SECRET (Vercel's cron requests) or
 *       Bearer PROXYMINER_ADMIN_API_TOKEN (manual curl).
 *
 *   GET /api/cron/reap-stale-jobs?older_than_minutes=5
 *
 * Schedule (vercel.json): every 10 minutes is plenty — orphans are
 * harmless until a user retries, and a 10-minute lag stays under the
 * recent-completed dedupe window.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

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

const DEFAULT_OLDER_THAN_MINUTES = 5;
const MIN_OLDER_THAN_MINUTES = 2;
const MAX_OLDER_THAN_MINUTES = 60;

export async function GET(req: NextRequest) {
  if (!hasValidBearer(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "db_unavailable" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get("older_than_minutes");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_OLDER_THAN_MINUTES;
  const minutes =
    Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, MIN_OLDER_THAN_MINUTES), MAX_OLDER_THAN_MINUTES)
      : DEFAULT_OLDER_THAN_MINUTES;
  const cutoffIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const updated = (await db().execute(sql`
    UPDATE ${schema.ingest_jobs}
    SET status = 'failed',
        completed_at = now(),
        note = coalesce(note, '') || '[reaped:stale]',
        detail = coalesce(detail, '{}'::jsonb) || ${JSON.stringify({
          error_code: "ingest_failed",
          error_message: "Worker did not finalize the job before the reap window. Try again.",
          reaped: true,
        })}::jsonb
    WHERE completed_at IS NULL
      AND status IN ('queued','resolving','fetching','extracting','saving')
      AND started_at < ${cutoffIso}::timestamptz
    RETURNING id, identifier, status, started_at
  `)) as unknown as Array<{
    id: number;
    identifier: string | null;
    status: string;
    started_at: Date;
  }>;

  return NextResponse.json({
    ok: true,
    reaped: updated.length,
    older_than_minutes: minutes,
    rows: updated.map((r) => ({
      id: Number(r.id),
      identifier: r.identifier,
    })),
  });
}
