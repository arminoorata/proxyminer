/**
 * Lifecycle helpers for the durable ingest job model.
 *
 * Jobs live in the existing `ingest_jobs` table; we don't add a new
 * one. The row is created at job submission (status='queued'), the
 * `after()` worker advances it through `resolving` → `fetching` →
 * `extracting` → `saving`, and finishes as `ok` / `partial` / `failed`.
 *
 * `ingest_jobs.detail` is the catch-all for non-column data: the
 * resolved company_id, per-filing counts, the last error code, and
 * any caller-supplied audit fields (e.g. hashed client identifier).
 */
import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export type JobStatus =
  | "queued"
  | "resolving"
  | "fetching"
  | "extracting"
  | "saving"
  | "ok"
  | "partial"
  | "failed";

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "ok",
  "partial",
  "failed",
]);
export const IN_FLIGHT_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "resolving",
  "fetching",
  "extracting",
  "saving",
]);

/** Maximum wall time a job can stay "in flight" before we consider
 * it crashed and let a new request take over. Pegged to the route
 * function's maxDuration plus a buffer. */
export const STALE_IN_FLIGHT_MS = 90 * 1000;

export const PHASE_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  resolving: "Resolving ticker on SEC EDGAR…",
  fetching: "Fetching DEF 14A filings…",
  extracting: "Extracting CD&A, peer panels, pay ratio, committee report…",
  saving: "Saving structured data…",
  ok: "Done",
  partial: "Done with warnings",
  failed: "Failed",
};

export interface JobDetail {
  client_hash?: string;
  company_id?: string | null;
  filings_processed?: number;
  errors?: string[];
  error_code?: string;
  error_message?: string;
  phase_started_at?: string;
  [k: string]: unknown;
}

export interface IngestJobRow {
  id: number;
  job_type: string;
  status: JobStatus;
  identifier: string | null;
  note: string | null;
  detail: JobDetail | null;
  started_at: Date;
  completed_at: Date | null;
}

interface CreateJobInput {
  identifier: string;
  job_type: string;
  client_hash?: string;
  company_id_hint?: string;
}

/** Atomic in-flight check + create. Returns the existing row when
 * another worker is already importing this ticker (and started within
 * STALE_IN_FLIGHT_MS), otherwise inserts a fresh `queued` row. */
export async function findOrCreateJob(input: CreateJobInput): Promise<{
  job: IngestJobRow;
  created: boolean;
}> {
  const conn = db();
  const identifier = input.identifier.trim();
  const cutoff = new Date(Date.now() - STALE_IN_FLIGHT_MS);

  // Look for an in-flight job for this identifier started recently.
  const existing = (await conn.execute(sql`
    SELECT id, job_type, status, identifier, note, detail, started_at, completed_at
    FROM ${schema.ingest_jobs}
    WHERE lower(identifier) = ${identifier.toLowerCase()}
      AND completed_at IS NULL
      AND started_at > ${cutoff}
      AND status IN ('queued','resolving','fetching','extracting','saving')
    ORDER BY started_at DESC
    LIMIT 1
  `)) as unknown as IngestJobRow[];

  if (existing.length > 0) {
    return { job: normalizeRow(existing[0]), created: false };
  }

  const detail: JobDetail = {};
  if (input.client_hash) detail.client_hash = input.client_hash;
  if (input.company_id_hint) detail.company_id = input.company_id_hint;
  detail.phase_started_at = new Date().toISOString();

  const [inserted] = await conn
    .insert(schema.ingest_jobs)
    .values({
      job_type: input.job_type,
      status: "queued",
      identifier,
      note: null,
      detail,
    })
    .returning();

  return { job: normalizeRow(inserted as unknown as IngestJobRow), created: true };
}

/** Phase-only update during the in-flight portion of the job. */
export async function updateJobPhase(
  job_id: number,
  next: JobStatus,
  detailMerge: Partial<JobDetail> = {},
): Promise<void> {
  await db()
    .update(schema.ingest_jobs)
    .set({
      status: next,
      detail: sql`coalesce(detail, '{}'::jsonb) || ${JSON.stringify({
        ...detailMerge,
        phase_started_at: new Date().toISOString(),
      })}::jsonb`,
    })
    .where(eq(schema.ingest_jobs.id, job_id));
}

interface FinalizeInput {
  status: "ok" | "partial" | "failed";
  note?: string;
  detail?: Partial<JobDetail>;
}

/** Terminal update. Sets completed_at and merges detail fields. */
export async function finalizeJob(
  job_id: number,
  input: FinalizeInput,
): Promise<void> {
  await db()
    .update(schema.ingest_jobs)
    .set({
      status: input.status,
      note: input.note ?? null,
      detail: sql`coalesce(detail, '{}'::jsonb) || ${JSON.stringify(input.detail ?? {})}::jsonb`,
      completed_at: new Date(),
    })
    .where(eq(schema.ingest_jobs.id, job_id));
}

export async function getJob(job_id: number): Promise<IngestJobRow | null> {
  const rows = await db()
    .select()
    .from(schema.ingest_jobs)
    .where(eq(schema.ingest_jobs.id, job_id))
    .limit(1);
  if (rows.length === 0) return null;
  return normalizeRow(rows[0] as unknown as IngestJobRow);
}

/** Look up the most recent terminal job for a ticker (used by the
 * 10-minute dedupe path that returns already_ingested). */
export async function findRecentCompletedJob(
  identifier: string,
  withinMs: number,
): Promise<IngestJobRow | null> {
  const cutoff = new Date(Date.now() - withinMs);
  const rows = (await db().execute(sql`
    SELECT id, job_type, status, identifier, note, detail, started_at, completed_at
    FROM ${schema.ingest_jobs}
    WHERE lower(identifier) = ${identifier.trim().toLowerCase()}
      AND completed_at IS NOT NULL
      AND completed_at > ${cutoff}
    ORDER BY completed_at DESC
    LIMIT 1
  `)) as unknown as IngestJobRow[];
  if (rows.length === 0) return null;
  return normalizeRow(rows[0]);
}

function normalizeRow(row: IngestJobRow): IngestJobRow {
  // Postgres returns dates as strings via the raw `execute` path;
  // normalize to Date so downstream callers don't need to branch.
  if (row.started_at && typeof row.started_at === "string") {
    row.started_at = new Date(row.started_at);
  }
  if (row.completed_at && typeof row.completed_at === "string") {
    row.completed_at = new Date(row.completed_at);
  }
  return row;
}

