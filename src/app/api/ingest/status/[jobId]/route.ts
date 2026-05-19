/**
 * Status read for a queued public-ingest job.
 *
 *   GET /api/ingest/status/123
 *
 * Public — anyone with a job id can poll it. Returns only the
 * safe-to-expose fields: status, phase label, identifier, resolved
 * company id, filing counts, error code+message. Raw stack traces
 * never escape the server.
 *
 * The companion POST /api/ingest/public/[ticker] endpoint returns
 * the job id; the import UI polls this route every couple of seconds
 * until the status is terminal (`ok` / `partial` / `failed`).
 */
import { NextRequest, NextResponse } from "next/server";

import {
  PHASE_LABELS,
  TERMINAL_STATUSES,
  getJob,
  type JobStatus,
} from "@/lib/services/ingest-jobs";

export const runtime = "nodejs";

const SAFE_ERROR_CODES = new Set([
  "invalid_ticker",
  "not_in_sec_tickers",
  "no_proxy_found",
  "sec_fetch_failed",
  "ingest_failed",
  "partial_failure",
  "rate_gate_failed",
  "client_cap",
  "db_unavailable",
]);

const SAFE_MESSAGES: Record<string, string> = {
  invalid_ticker:
    "Ticker shape rejected by the input validator.",
  not_in_sec_tickers:
    "SEC EDGAR doesn't list a company with this ticker. Check the spelling.",
  no_proxy_found:
    "SEC has no DEF 14A proxy filings on file for this company.",
  sec_fetch_failed:
    "SEC EDGAR didn't return a clean response. This is usually transient — try again in a minute.",
  ingest_failed:
    "Extraction failed unexpectedly. Report this if it persists.",
  partial_failure:
    "Some filings were imported but at least one failed. Open the company page to see what landed.",
  rate_gate_failed: "Rate limit check failed. Try again shortly.",
  client_cap: "Per-client cap reached. Wait an hour and try again.",
  db_unavailable: "Database unreachable. Try again shortly.",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "db_unavailable", message: "Postgres not configured" },
      { status: 503 },
    );
  }

  const { jobId } = await params;
  const id = Number.parseInt(jobId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json(
      { error: "invalid_job_id", message: "job id must be a positive integer" },
      { status: 400 },
    );
  }

  const job = await getJob(id);
  if (!job) {
    return NextResponse.json(
      { error: "not_found", message: "no such job" },
      { status: 404 },
    );
  }

  const status = job.status as JobStatus;
  const terminal = TERMINAL_STATUSES.has(status);
  const detail = job.detail ?? {};

  // Surface error_code/message only when it's in our allowlist. This
  // keeps unfamiliar codes (drizzle errors, pg connection strings)
  // from leaking to clients.
  let error_code: string | null = null;
  let error_message: string | null = null;
  if (typeof detail.error_code === "string" && SAFE_ERROR_CODES.has(detail.error_code)) {
    error_code = detail.error_code;
    error_message = SAFE_MESSAGES[error_code] ?? detail.error_message ?? null;
  }

  // Cache: terminal statuses can be cached briefly. In-flight must not.
  const headers: Record<string, string> = {
    "cache-control": terminal ? "public, max-age=30" : "no-store",
  };

  return NextResponse.json(
    {
      job_id: job.id,
      status,
      phase_label: PHASE_LABELS[status] ?? status,
      identifier: job.identifier,
      company_id: typeof detail.company_id === "string" ? detail.company_id : null,
      filings_processed:
        typeof detail.filings_processed === "number"
          ? detail.filings_processed
          : null,
      filings_total: typeof detail.filings_total === "number" ? detail.filings_total : null,
      terminal,
      error_code,
      error_message,
      started_at: job.started_at?.toISOString?.() ?? null,
      completed_at: job.completed_at?.toISOString?.() ?? null,
    },
    { headers },
  );
}
