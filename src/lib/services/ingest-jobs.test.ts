/**
 * Constant-shape tests for the durable job model. The DB-backed
 * `findOrCreateJob` / `updateJobPhase` / `finalizeJob` functions are
 * verified end-to-end against production after deploy — here we just
 * pin the invariants that would silently break the polling UI if a
 * future change diverged them.
 */
import { describe, expect, it } from "vitest";

import {
  IN_FLIGHT_STATUSES,
  PHASE_LABELS,
  PUBLIC_TOKEN_PATTERN,
  STALE_IN_FLIGHT_MS,
  TERMINAL_STATUSES,
  isValidPublicToken,
  type JobStatus,
} from "./ingest-jobs";

const ALL_STATUSES: JobStatus[] = [
  "queued",
  "resolving",
  "fetching",
  "extracting",
  "saving",
  "ok",
  "partial",
  "failed",
];

describe("ingest-jobs constants", () => {
  it("PHASE_LABELS covers every JobStatus", () => {
    for (const s of ALL_STATUSES) {
      expect(PHASE_LABELS[s]).toBeTruthy();
      expect(PHASE_LABELS[s].length).toBeGreaterThan(0);
    }
  });

  it("TERMINAL_STATUSES and IN_FLIGHT_STATUSES are mutually exclusive", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(IN_FLIGHT_STATUSES.has(s)).toBe(false);
    }
    for (const s of IN_FLIGHT_STATUSES) {
      expect(TERMINAL_STATUSES.has(s)).toBe(false);
    }
  });

  it("TERMINAL_STATUSES ∪ IN_FLIGHT_STATUSES covers every JobStatus", () => {
    for (const s of ALL_STATUSES) {
      const covered = TERMINAL_STATUSES.has(s) || IN_FLIGHT_STATUSES.has(s);
      expect(covered, `missing coverage for ${s}`).toBe(true);
    }
  });

  it("TERMINAL_STATUSES contains exactly ok/partial/failed", () => {
    expect(new Set(TERMINAL_STATUSES)).toEqual(
      new Set(["ok", "partial", "failed"]),
    );
  });

  it("STALE_IN_FLIGHT_MS sits within the route's maxDuration ceiling", () => {
    // Route declares maxDuration = 60s; the stale window must be at
    // least as long so a healthy worker won't be considered crashed.
    expect(STALE_IN_FLIGHT_MS).toBeGreaterThanOrEqual(60_000);
    // …but shouldn't be unbounded — keep it close to the ceiling so
    // failed workers don't block re-submissions for too long.
    expect(STALE_IN_FLIGHT_MS).toBeLessThanOrEqual(180_000);
  });

  it("queued status has a label distinct from 'Done'/'Failed'", () => {
    // Sanity check that we didn't collapse multiple statuses to the
    // same label — the UI relies on the label changing as the worker
    // advances.
    expect(PHASE_LABELS.queued).not.toBe(PHASE_LABELS.ok);
    expect(PHASE_LABELS.queued).not.toBe(PHASE_LABELS.failed);
    expect(PHASE_LABELS.fetching).not.toBe(PHASE_LABELS.extracting);
  });
});

describe("isValidPublicToken / PUBLIC_TOKEN_PATTERN", () => {
  it("accepts 24-char lowercase hex (the shape randomBytes(12).toString('hex') produces)", () => {
    expect(isValidPublicToken("a".repeat(24))).toBe(true);
    expect(isValidPublicToken("0123456789abcdef01234567")).toBe(true);
  });

  it("rejects empty / null / undefined", () => {
    expect(isValidPublicToken(null)).toBe(false);
    expect(isValidPublicToken(undefined)).toBe(false);
    expect(isValidPublicToken("")).toBe(false);
  });

  it("rejects raw integer ids — the previous (enumerable) shape", () => {
    expect(isValidPublicToken("142")).toBe(false);
    expect(isValidPublicToken("0")).toBe(false);
    expect(isValidPublicToken("9999999999")).toBe(false);
  });

  it("rejects uppercase hex (random tokens are lowercase by construction)", () => {
    expect(isValidPublicToken("A".repeat(24))).toBe(false);
  });

  it("rejects shorter / longer hex", () => {
    expect(isValidPublicToken("a".repeat(23))).toBe(false);
    expect(isValidPublicToken("a".repeat(25))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidPublicToken("g".repeat(24))).toBe(false);
    expect(isValidPublicToken("a".repeat(23) + "!")).toBe(false);
    expect(isValidPublicToken("../../../etc/passwd_xx")).toBe(false);
  });

  it("PUBLIC_TOKEN_PATTERN is anchored", () => {
    expect(PUBLIC_TOKEN_PATTERN.test("garbage" + "a".repeat(24) + "garbage")).toBe(
      false,
    );
  });
});
