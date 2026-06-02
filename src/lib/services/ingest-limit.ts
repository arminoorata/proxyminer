/**
 * Validation for the admin ingest `limit` query param — the number of most
 * recent filings per ticker to re-ingest (newest first).
 *
 * Mirrors the bounds the recover-cohort workflow enforces (default 2, 1-5)
 * so the workflow's check is not the only guard: a manual `curl` against
 * the route is bounded too. Pure + unit-tested (ingest-limit.test.ts).
 */
export const INGEST_LIMIT_DEFAULT = 2;
export const INGEST_LIMIT_MIN = 1;
export const INGEST_LIMIT_MAX = 5;

export type IngestLimitResult =
  | { ok: true; limit: number }
  | { ok: false; error: string };

/**
 * Parse and bound the raw `limit` query value.
 *
 * - absent / empty -> default (2)
 * - must be a short run of digits in [MIN, MAX]; anything else (negative,
 *   decimal, non-numeric, whitespace, or an over-long/overflow digit string)
 *   is rejected with a clear message so the route can return a typed 400.
 */
export function parseIngestLimit(raw: string | null | undefined): IngestLimitResult {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, limit: INGEST_LIMIT_DEFAULT };
  }
  // Bounded digit-only match: rejects "-1", "2.5", "abc", " 3 ", "0x3" and
  // overflow strings like "9999999999999999999999" before parseInt.
  if (!/^\d{1,3}$/.test(raw)) {
    return {
      ok: false,
      error: `limit must be an integer between ${INGEST_LIMIT_MIN} and ${INGEST_LIMIT_MAX}`,
    };
  }
  const n = Number.parseInt(raw, 10);
  if (n < INGEST_LIMIT_MIN || n > INGEST_LIMIT_MAX) {
    return {
      ok: false,
      error: `limit must be between ${INGEST_LIMIT_MIN} and ${INGEST_LIMIT_MAX} (got ${n})`,
    };
  }
  return { ok: true, limit: n };
}
