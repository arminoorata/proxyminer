/**
 * Drizzle client for Neon Postgres. Loaded lazily so the app can run
 * in fixture mode (no DATABASE_URL) for local dev and during the
 * pre-provisioning window.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

let _db: ReturnType<typeof drizzle> | null = null;

export function db(): ReturnType<typeof drizzle> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not set — falling back to fixture mode is supported via " +
        "src/lib/data/fixture-source.ts. The route handler should branch on " +
        "`fixtureMode()` before calling db().",
    );
  }
  // pg-server pooled connection. Vercel-friendly: each invocation gets
  // a short-lived connection from the pool. `max: 1` keeps the
  // serverless-instance footprint predictable.
  const client = postgres(url, { max: 1, prepare: false });
  _db = drizzle(client, { schema });
  return _db;
}

export type DB = ReturnType<typeof db>;
export { schema };
