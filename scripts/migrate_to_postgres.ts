/**
 * Phase-9 migration script. One-shot loader from the frozen fixtures
 * into the production Neon Postgres instance. Loads companies,
 * filings, sections, policy_facts, metric_facts, peer_groups +
 * peer_group_members, and exec_comp_rows so pg has the rich
 * Python-extracted data the fixture tree carries.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate_to_postgres.ts
 *
 * Idempotent: companies use onConflictDoUpdate, filings use
 * onConflictDoNothing, and per-filing artifacts are
 * delete-then-insert keyed on filing_id (matching ingest-service
 * semantics so re-running doesn't duplicate rows).
 *
 * The same logic is exposed at /api/admin/seed-from-fixtures so the
 * route can fire it from inside Vercel where DATABASE_URL is wired.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { db, schema } from "../src/lib/db/client";
import { seedFromFixtureTree } from "../src/lib/data/seed";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const root = join(process.cwd(), ".fixtures", "by-filing");
  if (!existsSync(root)) throw new Error(`fixture tree not found at ${root}`);
  const counts = await seedFromFixtureTree(root, { db: db(), schema, eq, fs: { existsSync, readFileSync, readdirSync }, path: { join } });
  // eslint-disable-next-line no-console
  console.log("seed complete:", counts);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
