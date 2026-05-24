/**
 * Phase 26 — pin the known-pending peer-panel pollution shape inside
 * the bundled fixtures.
 *
 * Public read paths fall through to `.fixtures/by-filing/` whenever
 * Postgres throws (see `src/lib/data/source.test.ts`). The fixtures
 * were frozen BEFORE Phase 11/11.5/16 tightened the peer-group
 * extractor, so CRM/NFLX/QCOM fixtures still carry the same
 * single-token-alias noise rows the production DB still carries.
 * The recovery workflow `recover-peer-pollution.yml` plus the
 * planned re-ingest after the 2026-06-01 Neon reset are the path
 * that clears BOTH the production rows AND (via a separate
 * fixtures:freeze pass) the fixtures.
 *
 * This test pins the current pollution shape so that:
 *
 *   1. If someone silently regenerates fixtures from a cleaner
 *      source without running the production recovery first, this
 *      test fails. CI would otherwise look green while production
 *      still serves polluted rows from the live DB.
 *
 *   2. If new pollution drifts into the fixture set, this test
 *      fails — operators see an unexpected `(parent, ticker)` pair
 *      and dig in instead of treating it as "the usual June 1 fix."
 *
 * The companion catalog at
 * `scripts/lib/known-pending-pollution.mjs` is the single source
 * of truth for what's "expected" pollution; the audit script and
 * this fixture test both read from it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error — pure ESM helper, no .d.ts; runtime import works.
import { KNOWN_PENDING_POLLUTION } from "../../../scripts/lib/known-pending-pollution.mjs";

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

interface PeerGroupFixture {
  members?: { ticker_resolved?: string | null }[];
}

function collectFixturePeerTickers(parent: string): Set<string> {
  const cdir = join(FIXTURES_ROOT, parent);
  const seen = new Set<string>();
  if (!existsSync(cdir)) return seen;
  // Walk every filing directory under this parent and union all
  // `ticker_resolved` values from every peer group's member list.
  // Even one polluted row anywhere in the parent's history would
  // surface here.
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

describe.runIf(existsSync(FIXTURES_ROOT))(
  "fixture peer-pollution shape (Phase 26)",
  () => {
    it("every known-pending suspect is still present in its parent's fixture peer rows", () => {
      // If this fails: someone refrozen fixtures and removed the
      // pending pollution. The recovery workflow has not yet run on
      // 2026-06-01 — refreezing now would mask the still-polluted
      // production DB until the next ingest cycle. Either run the
      // recovery first, or document the deviation in
      // docs/recovery.md before refreezing.
      for (const [parent, suspects] of KNOWN_PENDING_POLLUTION) {
        const observed = collectFixturePeerTickers(parent);
        for (const ticker of suspects) {
          expect(
            observed.has(ticker),
            `Expected ${ticker} to be present in ${parent} fixture peer rows ` +
              `(KNOWN_PENDING_POLLUTION). If you refrozen fixtures BEFORE the ` +
              `2026-06-01 Neon recovery, the production DB still has these ` +
              `rows and CI would look green falsely.`,
          ).toBe(true);
        }
      }
    });

    it("no UNEXPECTED suspect tickers appear in CRM/NFLX/QCOM fixture peer rows", () => {
      // Companion check: drift detection. If a NEW pollution-shaped
      // ticker shows up in one of the known-pending parents that
      // isn't already in the catalog, the catalog should be
      // updated (after the operator confirms it's stale-noise, not
      // a legitimate peer that just happens to look short).
      const KNOWN_SUSPECTS_GLOBAL = new Set<string>();
      for (const set of KNOWN_PENDING_POLLUTION.values()) {
        for (const t of set) KNOWN_SUSPECTS_GLOBAL.add(t);
      }
      // Suspect tickers as audit recognizes them (scripts/audit-peer-panels.mjs
      // SUSPECT_TICKERS). Inlined as a frozen subset; the audit list is the
      // source of truth, this just narrows the haystack to "tickers the
      // audit would also flag if they showed up in production."
      const AUDIT_SUSPECT_SAMPLE = new Set([
        "HEPS", "KFII", "TBTC", "FIVE", "ABVE", "SFWJ",
        "TWLV", "SLBT", "AMZE", "MLGO", "CRCL", "KVYO",
        "LRE", "CSTL", "YARIY", "CHOW", "JOSS", "NTPIF", "MVO",
      ]);
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

describe.runIf(!existsSync(FIXTURES_ROOT))(
  "fixture peer-pollution shape (gated)",
  () => {
    it("skipped — .fixtures/by-filing not present in this checkout", () => {
      expect(true).toBe(true);
    });
  },
);
