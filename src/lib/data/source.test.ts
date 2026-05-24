/**
 * Phase 25 — pin the source.ts pg → fixture fallback behavior under
 * Neon quota-shaped errors.
 *
 * The unified `source.ts` is the only read API the public surfaces
 * use (homepage, /api/cohort, /api/search/ticker, /company/[id],
 * /compare, /api/peerset/export, /api/company/[id]/export.pdf,
 * /api/ask, /api/search). When Neon throws — for any reason, but
 * crucially including the XX000 quota-exhausted SQLSTATE — every one
 * of those surfaces must continue rendering from the bundled
 * fixtures instead of bubbling a 500 to the user.
 *
 * These tests mock the pg-source module so they don't need a live
 * database. They cover the two failure shapes we've actually seen
 * from Neon Free: a postgres-js error with `code: "XX000"` and a
 * bare Error("data transfer quota exceeded").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `source.ts` imports `pg-source` lazily via `import("./pg-source")`.
// `vi.doMock` is the right tool: it intercepts the lazy import each
// time it fires.
afterEach(() => {
  vi.doUnmock("@/lib/data/pg-source");
  vi.resetModules();
  delete process.env.DATABASE_URL;
  delete process.env.PROXYMINER_USE_FIXTURES;
});

beforeEach(() => {
  // Simulate the production env where DATABASE_URL is configured.
  // Without this, source.ts goes straight to fixtures and never tries
  // the pg path we want to exercise.
  process.env.DATABASE_URL = "postgres://test/test";
  delete process.env.PROXYMINER_USE_FIXTURES;
});

function neonQuotaError(): Error {
  // Shape that postgres-js surfaces when Neon Free hits its monthly
  // data-transfer ceiling: a thrown Error with code "XX000" and a
  // message that mentions quota. Confirmed against the workflow
  // dispatch on 2026-05-23 (see docs/recovery.md).
  const err = new Error(
    "could not connect to neon: Your project has exceeded the data transfer quota.",
  ) as Error & { code: string };
  err.code = "XX000";
  return err;
}

describe("source.ts fallback when pg throws Neon XX000 (Phase 25)", () => {
  it("listCompanies falls back to fixtures instead of throwing", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      listCompanies: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const rows = await src.listCompanies();
    expect(rows.length).toBeGreaterThan(0);
    // Sanity: the cohort fixture has CRM/NFLX/QCOM in it.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("crm");
    expect(ids).toContain("nflx");
    expect(ids).toContain("qcom");
  });

  it("getCompany falls back to fixtures for a known cohort ticker", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      getCompany: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const row = await src.getCompany("crm");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("crm");
  });

  it("getCompany returns null for an unknown ticker under fallback", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      getCompany: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const row = await src.getCompany("zzznotaticker");
    expect(row).toBeNull();
  });

  it("listFilings falls back to fixtures for a known cohort ticker", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      listFilings: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const filings = await src.listFilings("crm");
    expect(filings.length).toBeGreaterThan(0);
  });

  it("getLatestFiling falls back to fixtures", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      getLatestFiling: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const detail = await src.getLatestFiling("crm");
    expect(detail).not.toBeNull();
    expect(detail!.executive_compensation.length).toBeGreaterThan(0);
  });

  it("getFilingDetail falls back to fixtures for a known filing", async () => {
    // First grab a real filing id from the fixture cohort so we don't
    // hardcode an id that drifts as new filings are frozen.
    process.env.PROXYMINER_USE_FIXTURES = "1";
    const fxSrc = await import("./source");
    const filings = await fxSrc.listFilings("crm");
    expect(filings.length).toBeGreaterThan(0);
    const knownFilingId = filings[0].id;
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://test/test";
    delete process.env.PROXYMINER_USE_FIXTURES;
    vi.doMock("@/lib/data/pg-source", () => ({
      getFilingDetail: vi.fn(async () => {
        throw neonQuotaError();
      }),
    }));
    const src = await import("./source");
    const detail = await src.getFilingDetail(knownFilingId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(knownFilingId);
  });

  it("does NOT swallow a non-quota error from pg — it falls back, but the warning preserves the original message", async () => {
    // Even for non-XX000 errors we still want the public surface to
    // render. The console.warn line is the operator's signal that
    // something is off; pin that the original error message reaches it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exoticErr = new Error("connection terminated unexpectedly");
    vi.doMock("@/lib/data/pg-source", () => ({
      listCompanies: vi.fn(async () => {
        throw exoticErr;
      }),
    }));
    const src = await import("./source");
    const rows = await src.listCompanies();
    expect(rows.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("pg listCompanies failed"),
      exoticErr,
    );
    warn.mockRestore();
  });
});

describe("source.ts fallback when pg returns empty (Phase 25)", () => {
  it("listCompanies falls through to fixtures when pg returns []", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      listCompanies: vi.fn(async () => []),
    }));
    const src = await import("./source");
    const rows = await src.listCompanies();
    expect(rows.length).toBeGreaterThan(0); // fixture set
  });

  it("getCompany falls through to fixtures when pg returns null", async () => {
    vi.doMock("@/lib/data/pg-source", () => ({
      getCompany: vi.fn(async () => null),
    }));
    const src = await import("./source");
    const row = await src.getCompany("crm");
    expect(row).not.toBeNull();
  });
});
