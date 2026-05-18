/**
 * Rate gate for the public on-demand ingest endpoint.
 *
 * Two protections, both backed by the existing `ingest_jobs` audit
 * trail (no new table):
 *
 *   1. Per-identifier dedupe — if the same ticker was ingested in the
 *      last 10 minutes, return "already_ingested" and short-circuit.
 *      Stops a refresh loop from hammering SEC for an already-fresh
 *      company.
 *
 *   2. Per-client cap — count public ingests in the last hour for the
 *      same hashed client (IP-derived). Reject above 5/hour. Hashing
 *      avoids storing raw IPs in the DB and keeps the audit trail
 *      privacy-safe.
 *
 * Storage shape: rate-limit fields live in `ingest_jobs.detail` so we
 * keep one source of truth and don't add a new table.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

const RECENT_IDENTIFIER_WINDOW_MS = 10 * 60 * 1000; // 10 min
const CLIENT_HOUR_WINDOW_MS = 60 * 60 * 1000;
const MAX_PUBLIC_INGESTS_PER_HOUR = 5;

const PUBLIC_JOB_TYPE = "public_ingest";

export interface RateGateResult {
  allowed: boolean;
  reason?: "already_ingested" | "client_cap" | "in_flight";
  recent_job_id?: number;
}

export function hashClient(ip: string | null | undefined): string {
  const salt = process.env.PROXYMINER_PUBLIC_INGEST_SALT ?? "proxyminer-public-ingest-v1";
  const raw = (ip ?? "anon").trim() || "anon";
  return createHash("sha256").update(`${salt}|${raw}`).digest("hex").slice(0, 24);
}

export function extractClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "anon";
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "anon";
}

export async function checkRateGate(
  identifier: string,
  clientHash: string,
): Promise<RateGateResult> {
  const idLower = identifier.trim().toLowerCase();
  const conn = db();

  // Per-identifier dedupe: any public OR admin ingest of this ticker in the
  // last 10 minutes is enough to short-circuit.
  const recentSameId = (await conn.execute(sql`
    SELECT id, started_at, completed_at, status
    FROM ${schema.ingest_jobs}
    WHERE lower(identifier) = ${idLower}
      AND started_at > now() - interval '10 minutes'
    ORDER BY started_at DESC
    LIMIT 1
  `)) as unknown as { id: number; status: string; completed_at: Date | null }[];
  if (recentSameId.length > 0) {
    const row = recentSameId[0];
    return {
      allowed: false,
      reason: row.completed_at ? "already_ingested" : "in_flight",
      recent_job_id: Number(row.id),
    };
  }

  // Per-client cap: 5/hour from this hashed client.
  const recentClient = (await conn.execute(sql`
    SELECT count(*)::int AS n
    FROM ${schema.ingest_jobs}
    WHERE job_type = ${PUBLIC_JOB_TYPE}
      AND started_at > now() - interval '1 hour'
      AND detail->>'client_hash' = ${clientHash}
  `)) as unknown as { n: number }[];
  const count = Number(recentClient[0]?.n ?? 0);
  if (count >= MAX_PUBLIC_INGESTS_PER_HOUR) {
    return { allowed: false, reason: "client_cap" };
  }

  return { allowed: true };
}

export const PUBLIC_INGEST_CONSTANTS = {
  RECENT_IDENTIFIER_WINDOW_MS,
  CLIENT_HOUR_WINDOW_MS,
  MAX_PUBLIC_INGESTS_PER_HOUR,
  PUBLIC_JOB_TYPE,
};
