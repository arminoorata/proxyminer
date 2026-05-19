/**
 * Per-client rate gate for the public on-demand ingest endpoint.
 *
 * One protection only — the per-client cap. Same-ticker dedupe
 * (already_ingested / in_flight) is now handled by the durable job
 * model in `ingest-jobs.ts` (findRecentCompletedJob +
 * findOrCreateJob). Splitting these concerns keeps each check fast
 * and the route handler easier to reason about.
 *
 * Per-client cap: count public ingests in the last hour for the same
 * hashed client (IP-derived). Reject above 5/hour. Hashing avoids
 * storing raw IPs in the DB.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

const CLIENT_HOUR_WINDOW_MS = 60 * 60 * 1000;
const MAX_PUBLIC_INGESTS_PER_HOUR = 5;

const PUBLIC_JOB_TYPE = "public_ingest";

export interface RateGateResult {
  allowed: boolean;
  reason?: "client_cap";
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
  _identifier: string,
  clientHash: string,
): Promise<RateGateResult> {
  const conn = db();
  const cutoffIso = new Date(Date.now() - CLIENT_HOUR_WINDOW_MS).toISOString();
  const recentClient = (await conn.execute(sql`
    SELECT count(*)::int AS n
    FROM ${schema.ingest_jobs}
    WHERE job_type = ${PUBLIC_JOB_TYPE}
      AND started_at > ${cutoffIso}::timestamptz
      AND detail->>'client_hash' = ${clientHash}
  `)) as unknown as { n: number }[];
  const count = Number(recentClient[0]?.n ?? 0);
  if (count >= MAX_PUBLIC_INGESTS_PER_HOUR) {
    return { allowed: false, reason: "client_cap" };
  }
  return { allowed: true };
}

export const PUBLIC_INGEST_CONSTANTS = {
  CLIENT_HOUR_WINDOW_MS,
  MAX_PUBLIC_INGESTS_PER_HOUR,
  PUBLIC_JOB_TYPE,
};
