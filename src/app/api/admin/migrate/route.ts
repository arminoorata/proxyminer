/**
 * One-shot DB setup endpoint. Runs the Drizzle migration files in
 * `./drizzle/` against the live `DATABASE_URL`. Safe to re-run —
 * Drizzle's migrate() tracks applied migrations.
 *
 *   curl -X POST https://<deploy>.vercel.app/api/admin/migrate \
 *     -H "Authorization: Bearer $PROXYMINER_ADMIN_API_TOKEN"
 */
import { NextRequest, NextResponse } from "next/server";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { error: "DATABASE_URL not set" },
      { status: 503 },
    );
  }

  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
