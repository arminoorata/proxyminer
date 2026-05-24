/**
 * Phase 31 — review-console session cookie validator.
 *
 * The cookie body has the form `${issued}.${sig}` where:
 *   - `issued` is the millisecond Unix timestamp of issuance
 *     (`String(Date.now())`) at /review/session
 *   - `sig` is `HMAC-SHA256(PROXYMINER_REVIEW_COOKIE_SECRET, issued)`
 *     hex-encoded
 *
 * A request is considered authenticated when ALL of:
 *   1. The secret env var is configured
 *   2. The cookie parses cleanly into the two parts
 *   3. `issued` is a finite positive integer
 *   4. The HMAC matches (timing-safe compare)
 *   5. `issued` is within `maxAgeMs` of `now`
 *
 * Before Phase 31, /review/page.tsx checked only (2) by way of cookie
 * presence — any opaque value passed. /review/update/route.ts checked
 * (1)–(4) but not (5), so a leaked cookie was usable indefinitely
 * server-side even though the browser would discard it after 8h.
 * This module fixes both gaps and centralises the logic so they
 * cannot drift apart again.
 *
 * Pure-ish: only relies on node:crypto and the system clock. Tests
 * pass `now` explicitly so timing branches are deterministic.
 */
import { createHmac } from "node:crypto";

export const REVIEW_COOKIE_NAME = "proxyminer_review";
export const REVIEW_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export type ReviewSessionResult =
  | { ok: true; issuedAt: number }
  | { ok: false; reason: ReviewSessionFailure };

export type ReviewSessionFailure =
  | "missing_secret"
  | "missing_value"
  | "malformed"
  | "bad_issued"
  | "bad_signature"
  | "expired";

/**
 * Validate a `proxyminer_review` cookie value against the secret +
 * the current clock. Returns `{ ok: true, issuedAt }` or a typed
 * failure reason.
 *
 * @param value cookie body (without the cookie name). May be empty.
 * @param secret hex/binary secret used to HMAC the issuance time.
 *   In production this is `process.env.PROXYMINER_REVIEW_COOKIE_SECRET`.
 * @param opts.now millisecond Unix timestamp. Caller-supplied so
 *   tests can pin both the issuance and the comparison.
 * @param opts.maxAgeMs upper bound on (now - issuedAt). Defaults to
 *   `REVIEW_SESSION_MAX_AGE_MS` (8h) to match the cookie's `maxAge`.
 */
export function validateReviewSession(
  value: string | undefined | null,
  secret: string | undefined | null,
  opts: { now?: number; maxAgeMs?: number } = {},
): ReviewSessionResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!value) return { ok: false, reason: "missing_value" };

  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) {
    // Either no dot, leading dot, or trailing dot — none parse to
    // (issued, sig). split() with the wrong shape would silently
    // give undefined for one side; indexOf is explicit.
    return { ok: false, reason: "malformed" };
  }
  const issuedStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const issuedAt = Number(issuedStr);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || !Number.isInteger(issuedAt)) {
    return { ok: false, reason: "bad_issued" };
  }

  const expectedSig = createHmac("sha256", secret).update(issuedStr).digest("hex");
  if (!timingSafeEqString(expectedSig, sig)) {
    return { ok: false, reason: "bad_signature" };
  }

  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? REVIEW_SESSION_MAX_AGE_MS;
  // Reject cookies issued in the future (clock skew or forgery
  // attempt) AND cookies older than maxAgeMs.
  if (issuedAt > now + 60_000 || now - issuedAt > maxAgeMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, issuedAt };
}

/**
 * Constant-time string comparison. Returns false fast on length
 * mismatch (length is not a secret in this protocol — the HMAC
 * output is fixed at 64 hex chars). On equal-length input the loop
 * always runs the full length to avoid early-exit timing.
 */
function timingSafeEqString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
