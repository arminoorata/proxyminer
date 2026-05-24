/**
 * Phase 27 — pin each verdict path of the reset-day classifier.
 *
 * The classifier is the brain of `npm run recovery:reset-day-check`.
 * It folds four independent probes (production aliveness, audit
 * output, catalog state, fixture state) into one of six lifecycle
 * verdicts. These tests pin every verdict so the operator-facing
 * "next action" string never silently changes shape after a refactor.
 *
 * Pure-function tests, no I/O. The classifier still reads the LIVE
 * `KNOWN_PENDING_POLLUTION` catalog for its FRESH-REGRESSION check
 * (a ticker is "unknown" if it isn't in the live catalog for that
 * parent); the cases below are constructed with that in mind.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — pure ESM helper, no .d.ts; runtime import works.
import { classifyResetDayState } from "../scripts/lib/reset-day-classify.mjs";

const ALIVE_OK = { alive: true, commit: "abc1234" };

function audit(polluted: Record<string, string[]>) {
  const m = new Map<string, string[]>();
  for (const [k, v] of Object.entries(polluted)) m.set(k, v);
  return { ok: true, exitCode: polluted ? 1 : 0, polluted: m };
}

const AUDIT_CLEAN = { ok: true, exitCode: 0, polluted: new Map() };

const CATALOG_LIVE = {
  empty: false,
  pairs: [
    { parent: "crm", suspects: ["HEPS", "KFII", "TBTC", "FIVE", "ABVE"] },
    { parent: "nflx", suspects: ["HEPS", "SFWJ"] },
    { parent: "qcom", suspects: ["HEPS"] },
  ],
};

const CATALOG_EMPTY = { empty: true, pairs: [] };

const FIXTURES_CLEAN = { available: true, suspectsStillPresent: [] };
const FIXTURES_POLLUTED = {
  available: true,
  suspectsStillPresent: [{ parent: "crm", tickers: ["HEPS"] }],
};

describe("classifyResetDayState (Phase 27)", () => {
  it("SITE-UNREACHABLE when /api/version fails", () => {
    const v = classifyResetDayState({
      alive: { alive: false, reason: "ECONNREFUSED" },
      audit: AUDIT_CLEAN,
      catalog: CATALOG_LIVE,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("SITE-UNREACHABLE");
    expect(v.next).toMatch(/ECONNREFUSED/);
  });

  it("AUDIT-FAILED when the audit script reports unusable output", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: { ok: false, exitCode: 127, polluted: new Map(), reason: "missing" },
      catalog: CATALOG_LIVE,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("AUDIT-FAILED");
    expect(v.next).toMatch(/status=127/);
  });

  it("PRE-RECOVERY when audit pollution matches catalog exactly + catalog populated", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: audit({
        crm: ["HEPS", "KFII", "TBTC", "FIVE", "ABVE"],
        nflx: ["HEPS", "SFWJ"],
        qcom: ["HEPS"],
      }),
      catalog: CATALOG_LIVE,
      fixtures: { available: true, suspectsStillPresent: CATALOG_LIVE.pairs },
    });
    expect(v.label).toBe("PRE-RECOVERY");
    expect(v.next).toMatch(/Neon Free|XX000/);
    expect(v.next).toMatch(/recover-peer-pollution\.yml/);
  });

  it("FRESH-REGRESSION when audit shows a (parent, ticker) outside the catalog", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: audit({
        // CRM is in the catalog but ZZZZ is not. The classifier must
        // call this a regression, not the standard recovery path.
        crm: ["ZZZZ"],
      }),
      catalog: CATALOG_LIVE,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("FRESH-REGRESSION");
    expect(v.next).toMatch(/CRM=ZZZZ/);
    expect(v.next).toMatch(/Do not run/);
  });

  it("FRESH-REGRESSION when catalog is empty but audit shows any pollution", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: audit({ aapl: ["HEPS"] }),
      catalog: CATALOG_EMPTY,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("FRESH-REGRESSION");
    expect(v.next).toMatch(/AAPL=HEPS/);
  });

  it("RECOVERY-DONE-FIXTURES-STALE when audit clean, catalog populated, fixtures still dirty", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: AUDIT_CLEAN,
      catalog: CATALOG_LIVE,
      fixtures: FIXTURES_POLLUTED,
    });
    expect(v.label).toBe("RECOVERY-DONE-FIXTURES-STALE");
    expect(v.next).toMatch(/fixtures:freeze/);
    expect(v.next).toMatch(/CRM=\[HEPS\]/);
  });

  it("FIXTURES-FRESH-CATALOG-STALE when audit clean + fixtures clean + catalog still populated", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: AUDIT_CLEAN,
      catalog: CATALOG_LIVE,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("FIXTURES-FRESH-CATALOG-STALE");
    expect(v.next).toMatch(/Retire the catalog/);
    expect(v.next).toMatch(/new Map\(\)/);
  });

  it("FULLY-CLEAN when audit clean + catalog empty", () => {
    const v = classifyResetDayState({
      alive: ALIVE_OK,
      audit: AUDIT_CLEAN,
      catalog: CATALOG_EMPTY,
      fixtures: FIXTURES_CLEAN,
    });
    expect(v.label).toBe("FULLY-CLEAN");
    expect(v.next).toMatch(/No action/);
    expect(v.next).toMatch(/POST-RECOVERY/);
  });

  it("uses the baseUrl option when surfacing SITE-UNREACHABLE", () => {
    const v = classifyResetDayState(
      {
        alive: { alive: false, reason: "timeout" },
        audit: AUDIT_CLEAN,
        catalog: CATALOG_LIVE,
        fixtures: FIXTURES_CLEAN,
      },
      { baseUrl: "https://staging.example.com" },
    );
    expect(v.next).toMatch(/staging\.example\.com/);
  });
});
