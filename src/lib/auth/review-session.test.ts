/**
 * Phase 31 — pin every reject branch of the review-session validator.
 *
 * The /review console + /review/update route both gate on this. Two
 * pre-Phase-31 bugs the tests below pin against regressing:
 *
 *   1. /review/page.tsx accepted ANY cookie value.
 *   2. /review/update/route.ts validated the HMAC but ignored expiry.
 *
 * Tests pass `now` explicitly so timing branches are deterministic.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REVIEW_COOKIE_NAME,
  REVIEW_SESSION_MAX_AGE_MS,
  validateReviewSession,
} from "./review-session";

const SECRET = "test-secret-not-used-in-prod";

function makeCookie(issuedAt: number, secret = SECRET): string {
  const issued = String(issuedAt);
  const sig = createHmac("sha256", secret).update(issued).digest("hex");
  return `${issued}.${sig}`;
}

describe("validateReviewSession (Phase 31)", () => {
  const now = 1_700_000_000_000;

  it("accepts a freshly issued cookie", () => {
    const cookie = makeCookie(now);
    expect(validateReviewSession(cookie, SECRET, { now })).toEqual({
      ok: true,
      issuedAt: now,
    });
  });

  it("accepts a cookie issued near the maxAge edge (just inside)", () => {
    const issuedAt = now - REVIEW_SESSION_MAX_AGE_MS + 60_000;
    expect(validateReviewSession(makeCookie(issuedAt), SECRET, { now })).toEqual({
      ok: true,
      issuedAt,
    });
  });

  it("rejects an expired cookie (older than maxAge)", () => {
    // The pre-Phase-31 validator accepted this. The browser would
    // discard the cookie at maxAge, but a leaked cookie was usable
    // server-side indefinitely.
    const issuedAt = now - REVIEW_SESSION_MAX_AGE_MS - 1;
    expect(validateReviewSession(makeCookie(issuedAt), SECRET, { now })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a cookie issued in the future (forgery / massive clock skew)", () => {
    const issuedAt = now + 5 * 60_000; // 5 minutes ahead, beyond the 60s tolerance
    expect(validateReviewSession(makeCookie(issuedAt), SECRET, { now })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("tolerates 60s of clock skew on issuance time", () => {
    const issuedAt = now + 30_000; // 30s ahead — still inside tolerance
    expect(
      validateReviewSession(makeCookie(issuedAt), SECRET, { now }),
    ).toMatchObject({ ok: true });
  });

  it("rejects when the HMAC secret is missing", () => {
    expect(validateReviewSession(makeCookie(now), "", { now })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(validateReviewSession(makeCookie(now), undefined, { now })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });

  it("rejects an empty / undefined cookie value", () => {
    expect(validateReviewSession("", SECRET, { now })).toEqual({
      ok: false,
      reason: "missing_value",
    });
    expect(validateReviewSession(undefined, SECRET, { now })).toEqual({
      ok: false,
      reason: "missing_value",
    });
    expect(validateReviewSession(null, SECRET, { now })).toEqual({
      ok: false,
      reason: "missing_value",
    });
  });

  it("rejects malformed values (no dot, leading dot, trailing dot)", () => {
    // The pre-Phase-31 read route accepted ALL of these because it
    // only checked cookie presence. Pin each shape so a future
    // regression can't quietly let them through.
    for (const v of ["nodot", ".justsig", "justissued.", ".", ""]) {
      const r = validateReviewSession(v, SECRET, { now });
      expect(r.ok, `value=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("rejects when the issued half isn't a finite positive integer", () => {
    // The validator splits on the FIRST dot, so `1.5.sig` parses to
    // (`1`, `5.sig`) — a valid integer + bad signature, not a bad
    // issued. Only inputs whose first-dot prefix fails Number()
    // hit the `bad_issued` branch.
    expect(validateReviewSession("abc.sig", SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_issued",
    });
    expect(validateReviewSession("-1.sig", SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_issued",
    });
    expect(validateReviewSession("0.sig", SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_issued",
    });
    expect(validateReviewSession("NaN.sig", SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_issued",
    });
  });

  it("rejects a cookie signed with the wrong secret", () => {
    const cookie = makeCookie(now, "different-secret");
    expect(validateReviewSession(cookie, SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a cookie whose signature was edited to the wrong length", () => {
    const cookie = makeCookie(now) + "deadbeef";
    expect(validateReviewSession(cookie, SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a cookie with the correct length but flipped signature bits", () => {
    const valid = makeCookie(now);
    const flipped =
      valid.slice(0, -1) + (valid.slice(-1) === "0" ? "1" : "0");
    expect(validateReviewSession(flipped, SECRET, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("uses the configured maxAgeMs override when provided", () => {
    const issuedAt = now - 2_000;
    // 1-second maxAge → 2s-old cookie is expired.
    expect(
      validateReviewSession(makeCookie(issuedAt), SECRET, {
        now,
        maxAgeMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("exposes the cookie name + max-age constants for callers", () => {
    expect(REVIEW_COOKIE_NAME).toBe("proxyminer_review");
    expect(REVIEW_SESSION_MAX_AGE_MS).toBe(8 * 60 * 60 * 1000);
  });
});
