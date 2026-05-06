/**
 * One-shot fixture-to-Postgres seeder. Loads the rich Python-extracted
 * artifacts from the bundled `.fixtures/by-filing/` tree (32 filings,
 * 12 companies) into Neon Postgres in a single request. Useful for
 * activating pg-reads without waiting for the weekly cron to re-extract
 * (cron is rate-limited by SEC's 10 req/sec budget; seeder is local).
 *
 *   curl -X POST https://proxyminer.vercel.app/api/admin/seed-from-fixtures \
 *     -H "Authorization: Bearer $PROXYMINER_ADMIN_API_TOKEN"
 *
 * Idempotent: per-filing artifacts use delete-then-insert keyed on
 * filing_id, matching `ingest-service.ts` semantics so re-running the
 * seeder doesn't duplicate.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { db, schema } from "@/lib/db/client";
import { seedFromFixtureTree } from "@/lib/data/seed";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 503 });
  }

  const root = join(process.cwd(), ".fixtures", "by-filing");
  if (!existsSync(root)) {
    return NextResponse.json(
      { error: `fixture tree not found at ${root} — was outputFileTracingIncludes set?` },
      { status: 503 },
    );
  }

  try {
    const counts = await seedFromFixtureTree(root, {
      db: db(),
      schema,
      eq,
      fs: { existsSync, readFileSync, readdirSync },
      path: { join },
    });
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
