-- Durable on-demand ingest: schema hardening (Phase 5).
--
-- Two changes, both idempotent (IF NOT EXISTS guards):
--   1. Partial unique index on (lower(identifier)) WHERE completed_at IS NULL
--      → DB-enforced at-most-one in-flight job per identifier. Closes the
--      race in findOrCreateJob where two concurrent POSTs both see "no
--      existing job" and both insert.
--   2. New `public_token` varchar column + unique index. The status
--      endpoint now keys off this app-generated token instead of the
--      serial id, so /api/ingest/status/<token> is non-enumerable.
--      Tokens are produced via node:crypto.randomBytes(12).toString('hex')
--      (24-char hex) — no pgcrypto extension required.
--
-- Migration runner is `drizzle-orm/postgres-js/migrator`, which runs the
-- whole file in a transaction. `CREATE INDEX CONCURRENTLY` is therefore
-- forbidden here; non-concurrent CREATE UNIQUE INDEX is fine on the
-- small ingest_jobs table (~150 rows in production), where the brief
-- ACCESS EXCLUSIVE lock costs milliseconds.

-- Step 1. Finalize any orphan in-flight rows so the partial unique
-- index can be created without conflict. Anything in-flight for more
-- than an hour is dead per the runtime's 90s stale window; the
-- defensive sweep here catches the corner where the migration runs on
-- a table that happens to contain one.
UPDATE "ingest_jobs"
SET status = 'failed',
    completed_at = now(),
    note = coalesce(note, '') || '[reaped:pre-migration]',
    detail = coalesce(detail, '{}'::jsonb) ||
             '{"error_code":"ingest_failed","reaped":true,"error_message":"Reaped during durable-ingest schema migration."}'::jsonb
WHERE completed_at IS NULL
  AND started_at < now() - interval '1 hour';
--> statement-breakpoint

-- Step 2. Partial unique index. NULL completed_at = still in flight;
-- once a job finishes, the row no longer participates in the unique
-- constraint and the same ticker can be resubmitted.
CREATE UNIQUE INDEX IF NOT EXISTS "ingest_jobs_inflight_per_identifier"
  ON "ingest_jobs" (lower("identifier"))
  WHERE completed_at IS NULL;
--> statement-breakpoint

-- Step 3. Public token column. Nullable on existing rows (they are
-- audit history; no one is polling them). New rows always insert a
-- non-null token.
ALTER TABLE "ingest_jobs"
  ADD COLUMN IF NOT EXISTS "public_token" varchar(32);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ingest_jobs_public_token_idx"
  ON "ingest_jobs" ("public_token");
