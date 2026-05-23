/**
 * Phase 22 — public import quota/degraded UX.
 *
 * Pins three contracts that the homepage autocomplete and the
 * /import/[ticker] runner both depend on:
 *
 *   1. When SEC search degrades to the bundled fallback, hits NOT
 *      already in the DB must be classified "unavailable_degraded"
 *      so the UI doesn't queue an ingest job that's guaranteed to
 *      fail under Vercel data-transfer quota.
 *
 *   2. When the same search is degraded but the hit IS already in
 *      the DB, navigation to /company/[id] must still be allowed —
 *      the quota only affects new imports, not existing companies.
 *
 *   3. The ingest error classifier must collapse all platform-quota
 *      shaped errors (typed code + free-text message detection) into
 *      a single bucket so the ImportRunner can hide the Retry button.
 */
import { describe, expect, it } from "vitest";

import {
  PLATFORM_QUOTA_MESSAGE,
  classifyImportAvailability,
  classifyImportError,
  isPlatformQuotaMessage,
} from "./import-availability";

describe("classifyImportAvailability (Phase 22)", () => {
  it("degraded + not_in_db → unavailable_degraded (no import offered)", () => {
    expect(classifyImportAvailability({ in_db: false }, true)).toBe(
      "unavailable_degraded",
    );
  });

  it("degraded + in_db → in_db (existing company still navigable)", () => {
    expect(classifyImportAvailability({ in_db: true }, true)).toBe("in_db");
  });

  it("live + not_in_db → available (normal import path)", () => {
    expect(classifyImportAvailability({ in_db: false }, false)).toBe(
      "available",
    );
  });

  it("live + in_db → in_db", () => {
    expect(classifyImportAvailability({ in_db: true }, false)).toBe("in_db");
  });
});

describe("isPlatformQuotaMessage (Phase 22)", () => {
  it("matches the exact Vercel quota message", () => {
    expect(
      isPlatformQuotaMessage(
        "Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.",
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isPlatformQuotaMessage("DATA TRANSFER QUOTA exceeded")).toBe(true);
  });

  it("does not match generic SEC failures", () => {
    expect(
      isPlatformQuotaMessage("SEC fetch failed (503): https://www.sec.gov/..."),
    ).toBe(false);
  });

  it("does not match empty / null", () => {
    expect(isPlatformQuotaMessage(null)).toBe(false);
    expect(isPlatformQuotaMessage(undefined)).toBe(false);
    expect(isPlatformQuotaMessage("")).toBe(false);
  });
});

describe("classifyImportError (Phase 22)", () => {
  it("typed platform_quota_exceeded → platform_quota", () => {
    expect(
      classifyImportError({
        code: "platform_quota_exceeded",
        message: PLATFORM_QUOTA_MESSAGE,
      }),
    ).toBe("platform_quota");
  });

  it("untyped error with quota-shaped message → platform_quota", () => {
    expect(
      classifyImportError({
        code: "http_503",
        message:
          "Your project has exceeded the data transfer quota. Upgrade your plan.",
      }),
    ).toBe("platform_quota");
  });

  it("sec_fetch_failed (no quota message) → sec_transient", () => {
    expect(
      classifyImportError({
        code: "sec_fetch_failed",
        message: "SEC EDGAR returned 502.",
      }),
    ).toBe("sec_transient");
  });

  it("client_cap → other (real rate-limit shouldn't read as platform quota)", () => {
    expect(
      classifyImportError({
        code: "client_cap",
        message: "You've imported 5 companies in the last hour.",
      }),
    ).toBe("other");
  });

  it("invalid_ticker → other", () => {
    expect(
      classifyImportError({
        code: "invalid_ticker",
        message: "Ticker shape rejected.",
      }),
    ).toBe("other");
  });
});
