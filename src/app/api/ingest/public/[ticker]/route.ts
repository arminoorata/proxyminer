/**
 * Public on-demand ingest — durable model.
 *
 *   POST /api/ingest/public/AAPL
 *
 * Behavior:
 *   1. Validate ticker shape.                    → 400 invalid_ticker
 *   2. Run rate gate (client cap + recent-dupe). → 429 client_cap
 *      A completed-within-10-min match short-circuits to
 *      `{status:"already_ingested", company_id, recent_job_id}`.
 *   3. Atomically find-or-create an ingest job for this ticker. If a
 *      job started in the last 90s is still running, return THAT
 *      `{job_id, status:"running"}` — refreshes / re-clicks attach to
 *      it instead of spawning a duplicate.
 *   4. Schedule the actual work via `after()` so the response can
 *      return immediately. The worker advances the job through
 *      `resolving → fetching → extracting → saving`, finalizing as
 *      `ok` / `partial` / `failed`. Even if the function spawning the
 *      worker times out, the job row keeps its last phase — the next
 *      request after the stale window can take over.
 *   5. Front-end polls `/api/ingest/status/[jobId]` to track progress
 *      and redirect to `/company/[id]` on `ok` / `partial`.
 *
 * No admin token. Anyone can POST. Backed by the public-ingest rate
 * gate (5/hour per hashed client + 10-min same-ticker dedupe).
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";

import { ingestCompany } from "@/lib/services/ingest-service";
import type { IngestProgressUpdate } from "@/lib/services/ingest-service";
import {
  findOrCreateJob,
  finalizeJob,
  findRecentCompletedJob,
  updateJobPhase,
} from "@/lib/services/ingest-jobs";
import {
  checkRateGate,
  extractClientIp,
  hashClient,
} from "@/lib/services/public-ingest-gate";
import { isValidTickerShape } from "@/lib/services/ticker-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

const ALREADY_INGESTED_WINDOW_MS = 10 * 60 * 1000;

function isPgUndefinedColumn(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: string }).code === "42703";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "db_unavailable", message: "Postgres not configured" },
      { status: 503 },
    );
  }

  const { ticker } = await params;
  const cleaned = (ticker ?? "").trim();
  if (!isValidTickerShape(cleaned)) {
    return NextResponse.json(
      {
        error: "invalid_ticker",
        message:
          "Ticker must be 1–8 characters and may contain letters, digits, '.', or '-'.",
      },
      { status: 400 },
    );
  }

  const lowerId = cleaned.toLowerCase();
  const clientHash = hashClient(extractClientIp(req.headers));

  // Recent-completed short-circuit (preserves the original
  // already_ingested UX so the front-end can redirect immediately).
  let recent;
  try {
    recent = await findRecentCompletedJob(cleaned, ALREADY_INGESTED_WINDOW_MS);
  } catch (err) {
    return NextResponse.json(
      {
        error: "rate_gate_failed",
        message: err instanceof Error ? err.message : "rate gate failed",
      },
      { status: 500 },
    );
  }
  if (recent && (recent.status === "ok" || recent.status === "partial")) {
    return NextResponse.json({
      ok: true,
      status: "already_ingested",
      // Pre-migration rows have null public_token; the client falls
      // back to the company page via company_id in that case.
      job_token: recent.public_token,
      company_id: recent.detail?.company_id ?? lowerId,
      message: "Already imported in the last 10 minutes.",
    });
  }

  // Per-client cap (unchanged from the synchronous flow). We still
  // count completed + in-flight jobs for this client over the last
  // hour; the 5/hour ceiling applies whether the import succeeded
  // or not.
  let gate;
  try {
    gate = await checkRateGate(cleaned, clientHash);
  } catch (err) {
    return NextResponse.json(
      {
        error: "rate_gate_failed",
        message: err instanceof Error ? err.message : "rate gate failed",
      },
      { status: 500 },
    );
  }
  // `in_flight` from the legacy gate is now covered by findOrCreateJob;
  // `already_ingested` is handled above. The gate's remaining job is
  // the per-client cap.
  if (!gate.allowed && gate.reason === "client_cap") {
    return NextResponse.json(
      {
        error: "client_cap",
        message: "You've imported 5 companies in the last hour. Try again later.",
      },
      { status: 429 },
    );
  }

  // Find-or-create the job row. The partial unique index on
  // lower(identifier) WHERE completed_at IS NULL makes this race-safe:
  // the SELECT-then-INSERT pattern handles the common case, and the
  // catch-and-reselect path (inside findOrCreateJob) handles the rare
  // window where two POSTs race past the SELECT.
  let created: boolean;
  let jobId: number;
  let jobToken: string | null;
  try {
    const { job, created: didCreate } = await findOrCreateJob({
      identifier: cleaned,
      job_type: "public_ingest",
      client_hash: clientHash,
      company_id_hint: lowerId,
    });
    jobId = job.id;
    jobToken = job.public_token;
    created = didCreate;
  } catch (err) {
    // Pre-migration window: if the public_token column or partial
    // unique index isn't there yet, surface a typed 503 so the UI
    // shows "migration pending" rather than a generic 500.
    if (isPgUndefinedColumn(err)) {
      return NextResponse.json(
        {
          error: "migration_pending",
          message:
            "Server schema is awaiting the durable-ingest migration. Try again shortly.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: "job_create_failed",
        message: err instanceof Error ? err.message : "could not create job",
      },
      { status: 500 },
    );
  }

  if (!created) {
    return NextResponse.json({
      ok: true,
      status: "running",
      job_token: jobToken,
      company_id: lowerId,
      message: "Existing import is still running for this ticker.",
    });
  }

  // Schedule the durable work. `after()` keeps the function alive
  // past response, up to the route's maxDuration ceiling.
  after(async () => {
    const onProgress = async (update: IngestProgressUpdate) => {
      await updateJobPhase(jobId, update.phase, {
        company_id: update.company_id ?? null,
        filings_processed: update.filings_processed,
        filings_total: update.filings_total,
        current_filing: update.current_filing,
      });
    };

    try {
      const result = await ingestCompany(cleaned, {
        limit: 2,
        audit_job_id: jobId,
        audit: { job_type: "public_ingest", client_hash: clientHash },
        onProgress,
      });

      if (result.filings_processed === 0 && result.errors.length === 0) {
        await finalizeJob(jobId, {
          status: "failed",
          note: "no DEF 14A found",
          detail: {
            company_id: result.company_id,
            filings_processed: 0,
            errors: [],
            error_code: "no_proxy_found",
            error_message:
              "SEC has no DEF 14A proxy filings on file for this ticker.",
          },
        });
        return;
      }

      const status =
        result.errors.length > 0
          ? result.filings_processed > 0
            ? "partial"
            : "failed"
          : "ok";
      await finalizeJob(jobId, {
        status,
        note: `processed=${result.filings_processed} errors=${result.errors.length}`,
        detail: {
          company_id: result.company_id,
          filings_processed: result.filings_processed,
          errors: result.errors,
          error_code:
            status === "failed"
              ? "ingest_failed"
              : status === "partial"
                ? "partial_failure"
                : undefined,
          error_message:
            status === "failed"
              ? "Extraction produced no rows. Check SEC for filing structure."
              : undefined,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let error_code = "ingest_failed";
      if (msg.startsWith("could not resolve identifier")) {
        error_code = "not_in_sec_tickers";
      } else if (msg.startsWith("SEC fetch failed")) {
        error_code = "sec_fetch_failed";
      }
      await finalizeJob(jobId, {
        status: "failed",
        note: msg.slice(0, 240),
        detail: {
          error_code,
          error_message: msg,
        },
      });
    }
  });

  return NextResponse.json({
    ok: true,
    status: "queued",
    job_token: jobToken,
    company_id: lowerId,
    message: "Import queued.",
  });
}
