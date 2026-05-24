/**
 * Phase 26 / 27 — fixture peer-pollution lifecycle guard.
 *
 * Two regimes, switched by `isCatalogEmpty()` from the
 * `scripts/lib/known-pending-pollution.mjs` catalog (Phase 27).
 *
 *   PRE-RECOVERY (catalog non-empty)
 *     - The catalog enumerates the (parent, suspect) peer rows the
 *       production DB still carries from the Phase 11-era extractor.
 *     - Production reads under Neon-quota fallback serve from
 *       `.fixtures/by-filing/`, which was frozen with the SAME
 *       polluted rows.
 *     - This test asserts every catalog suspect IS PRESENT in the
 *       corresponding parent's fixture peer rows. If it weren't,
 *       a silent refreeze before recovery would make CI look green
 *       while production still has the live polluted rows.
 *
 *   POST-RECOVERY (catalog empty)
 *     - Operator has executed the full reset-day sequence (recovery
 *       workflow → cohort re-ingest → `npm run fixtures:freeze` →
 *       catalog retirement). See docs/recovery.md.
 *     - This test FLIPS its expectation: no suspect-shaped ticker
 *       may appear in any cohort parent's fixture peer rows. Any
 *       hit is a fresh regression.
 *
 * The catalog itself is the toggle. There is no date check.
 * Operator empties the Map to flip the regime; the test enforces
 * the ordering by refusing to assert clean fixtures unless the
 * catalog is actually empty.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error — pure ESM helper, no .d.ts; runtime import works.
import {
  KNOWN_PENDING_POLLUTION,
  isCatalogEmpty,
} from "../../../scripts/lib/known-pending-pollution.mjs";

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

interface PeerGroupFixture {
  members?: { ticker_resolved?: string | null }[];
}

// The audit's suspect list — the set of tickers that ANY cohort
// parent's fixture would be wrong to carry once the catalog has been
// retired. Kept in sync with `scripts/audit-peer-panels.mjs`
// SUSPECT_TICKERS (subset). This is intentionally a small
// fixed sample of the audit's full list — we only need enough
// coverage to catch a refreeze that reintroduced the same noise
// patterns, and the audit's full list is the live source of truth.
const AUDIT_SUSPECT_SAMPLE = new Set([
  "HEPS",
  "KFII",
  "TBTC",
  "FIVE",
  "ABVE",
  "SFWJ",
  "TWLV",
  "SLBT",
  "AMZE",
  "MLGO",
  "CRCL",
  "KVYO",
  "LRE",
  "CSTL",
  "YARIY",
  "CHOW",
  "JOSS",
  "NTPIF",
  "MVO",
]);

function listCohortParentDirs(): string[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  return readdirSync(FIXTURES_ROOT).filter((name) => {
    const cdir = join(FIXTURES_ROOT, name);
    try {
      return existsSync(join(cdir, "company.json"));
    } catch {
      return false;
    }
  });
}

function collectFixturePeerTickers(parent: string): Set<string> {
  const cdir = join(FIXTURES_ROOT, parent);
  const seen = new Set<string>();
  if (!existsSync(cdir)) return seen;
  for (const filing of readdirSync(cdir).filter((f) => /^\d/.test(f))) {
    const fp = join(cdir, filing, "peer_groups.json");
    if (!existsSync(fp)) continue;
    const groups = JSON.parse(readFileSync(fp, "utf8")) as PeerGroupFixture[];
    for (const g of groups) {
      for (const m of g.members ?? []) {
        if (m.ticker_resolved) seen.add(m.ticker_resolved);
      }
    }
  }
  return seen;
}

describe.runIf(existsSync(FIXTURES_ROOT) && !isCatalogEmpty())(
  "fixture peer-pollution shape — PRE-RECOVERY (Phase 27)",
  () => {
    it("every known-pending suspect IS PRESENT in its parent's fixture peer rows", () => {
      // If this fails: someone refrozen fixtures and removed the
      // pending pollution while the catalog still names it. The
      // production DB still has those rows; CI under fixture
      // fallback would now look green falsely.
      //
      // Recovery path:
      //   - If June 1 recovery + re-ingest + refreeze has happened,
      //     run `npm run recovery:reset-day-check` and follow the
      //     printed action to RETIRE the catalog.
      //   - Otherwise, revert the fixture change. Refreeze is
      //     gated on production recovery completing first.
      for (const [parent, suspects] of KNOWN_PENDING_POLLUTION) {
        const observed = collectFixturePeerTickers(parent);
        for (const ticker of suspects) {
          expect(
            observed.has(ticker),
            [
              `Expected ${ticker} to be present in ${parent} fixture peer rows.`,
              `KNOWN_PENDING_POLLUTION still names it as a pending row, but the`,
              `fixture no longer carries it. If you refroze fixtures BEFORE the`,
              `2026-06-01 production recovery completed, the production DB still`,
              `has these rows and CI would look green falsely.`,
              `→ Run \`npm run recovery:reset-day-check\` and follow the next-`,
              `  action it prints. Do NOT silently keep this test green.`,
            ].join("\n"),
          ).toBe(true);
        }
      }
    });

    it("no UNEXPECTED suspect tickers appear in CRM/NFLX/QCOM fixture peer rows", () => {
      // Drift detection: a new suspect-shaped ticker showing up in
      // a known-pending parent's fixture that ISN'T in the catalog
      // either means new pollution drifted in, or the catalog is
      // out of date. Diagnose before adding to the catalog.
      const KNOWN_SUSPECTS_GLOBAL = new Set<string>();
      for (const set of KNOWN_PENDING_POLLUTION.values()) {
        for (const t of set) KNOWN_SUSPECTS_GLOBAL.add(t);
      }
      for (const parent of KNOWN_PENDING_POLLUTION.keys()) {
        const observed = collectFixturePeerTickers(parent);
        for (const ticker of observed) {
          if (
            AUDIT_SUSPECT_SAMPLE.has(ticker) &&
            !KNOWN_SUSPECTS_GLOBAL.has(ticker)
          ) {
            throw new Error(
              `Unexpected suspect ticker in ${parent} fixtures: ${ticker}. ` +
                `Update scripts/lib/known-pending-pollution.mjs if this is ` +
                `legitimate pending pollution, otherwise diagnose.`,
            );
          }
        }
      }
    });
  },
);

describe.runIf(existsSync(FIXTURES_ROOT) && isCatalogEmpty())(
  "fixture peer-pollution shape — POST-RECOVERY (Phase 27)",
  () => {
    it("NO suspect-shaped ticker appears in any cohort parent's fixture peer rows", () => {
      // The catalog has been retired. Fixtures should have been
      // refrozen from a clean post-recovery production DB. Any
      // suspect ticker showing up here is a fresh regression —
      // either the refreeze pulled from a stale snapshot, or the
      // recovery didn't actually clean what the catalog claimed.
      for (const parent of listCohortParentDirs()) {
        const observed = collectFixturePeerTickers(parent);
        for (const ticker of observed) {
          if (AUDIT_SUSPECT_SAMPLE.has(ticker)) {
            throw new Error(
              [
                `Suspect ticker ${ticker} re-appeared in ${parent} fixtures`,
                `AFTER the catalog was retired. This is a fresh regression:`,
                `either the refreeze pulled stale data, or the recovery did`,
                `not actually clean the row it claimed to.`,
                `→ Re-run the audit on production:`,
                `    node scripts/audit-peer-panels.mjs --verbose`,
                `  and if the live DB also shows ${ticker} on ${parent},`,
                `  treat this as a new pollution incident, not a refreeze`,
                `  bug.`,
              ].join("\n"),
            );
          }
        }
      }
    });
  },
);

describe.runIf(!existsSync(FIXTURES_ROOT))(
  "fixture peer-pollution shape (gated)",
  () => {
    it("skipped — .fixtures/by-filing not present in this checkout", () => {
      expect(true).toBe(true);
    });
  },
);
