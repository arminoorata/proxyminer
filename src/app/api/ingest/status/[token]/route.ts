/**
 * Status read for a queued public-ingest job — keyed by the
 * app-generated public token, not the serial id.
 *
 *   GET /api/ingest/status/<24-char-hex>
 *
 * The token is set at INSERT time (see ingest-jobs.findOrCreateJob)
 * and is the only identifier the browser ever sees. Internal serial
 * ids stay server-side. Tokens are unguessable (96 bits of entropy)
 * so the previous "anyone can enumerate import history" surface is
 * closed.
 *
 * Pre-migration safety: if the public_token column doesn't exist yet
 * (lookup fails with 42703 "undefined_column"), we return a 503 with
 * a typed code so the front-end shows "migration pending" rather than
 * silently looping.
 */
import { NextRequest, NextResponse } from "next/server";

import { PLATFORM_QUOTA_MESSAGE } from "@/lib/services/import-availability";
import {
  PHASE_LABELS,
  TERMINAL_STATUSES,
  getJobByPublicToken,
  isValidPublicToken,
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
  "recent_job_lookup_failed",
  "client_cap",
  "db_unavailable",
  "platform_quota_exceeded",
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
  recent_job_lookup_failed:
    "Couldn't check whether this company was recently imported. Try again shortly.",
  client_cap: "Per-client cap reached. Wait an hour and try again.",
  db_unavailable: "Database unreachable. Try again shortly.",
  platform_quota_exceeded: PLATFORM_QUOTA_MESSAGE,
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "db_unavailable", message: "Postgres not configured" },
      { status: 503 },
    );
  }

  const { token } = await params;
  // 24-char hex tokens only. This deliberately rejects raw integer ids:
  // serial-id lookup was the previous (enumerable) shape.
  if (!isValidPublicToken(token)) {
    return NextResponse.json(
      {
        error: "invalid_token",
        message:
          "Job tokens are 24-character hex strings. Serial ids are no longer accepted.",
      },
      { status: 400 },
    );
  }

  let job;
  try {
    job = await getJobByPublicToken(token);
  } catch (err) {
    // The migration creating `public_token` may not have been applied
    // yet. Return a typed 503 instead of a 500 so the front-end can
    // surface a clear message.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "42703"
    ) {
      return NextResponse.json(
        {
          error: "migration_pending",
          message:
            "Server schema is awaiting the durable-ingest migration. Try again shortly.",
        },
        { status: 503 },
      );
    }
    throw err;
  }
  if (!job) {
    return NextResponse.json(
      { error: "not_found", message: "no such job" },
      { status: 404 },
    );
  }

  const status = job.status as JobStatus;
  const terminal = TERMINAL_STATUSES.has(status);
  const detail = job.detail ?? {};

  let error_code: string | null = null;
  let error_message: string | null = null;
  if (typeof detail.error_code === "string" && SAFE_ERROR_CODES.has(detail.error_code)) {
    error_code = detail.error_code;
    error_message = SAFE_MESSAGES[error_code] ?? detail.error_message ?? null;
  }

  const headers: Record<string, string> = {
    "cache-control": terminal ? "public, max-age=30" : "no-store",
  };

  return NextResponse.json(
    {
      job_token: job.public_token,
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
