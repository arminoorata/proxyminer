/**
 * Phase 27 — pure classifier for the recovery reset-day state
 * machine. Extracted from `scripts/recovery-reset-day-check.mjs` so
 * each verdict path is unit-testable without spawning audits or
 * hitting production.
 *
 * Input shape:
 *   {
 *     alive:    { alive: bool, reason?: string },
 *     audit:    { ok: bool, exitCode: number, polluted: Map<string, string[]>, reason?: string },
 *     catalog:  { empty: bool, pairs: { parent: string, suspects: string[] }[] },
 *     fixtures: { available: bool, suspectsStillPresent: { parent: string, tickers: string[] }[] }
 *   }
 *
 * Output:
 *   { label, next } — short label naming the state and a
 *   single-paragraph operator-facing next action.
 */

import { KNOWN_PENDING_POLLUTION } from "./known-pending-pollution.mjs";

export function classifyResetDayState(
  { alive, audit, catalog, fixtures },
  { baseUrl = "https://proxyminer.arminoorata.com" } = {},
) {
  if (!alive.alive) {
    return {
      label: "SITE-UNREACHABLE",
      next:
        `Production at ${baseUrl} is unreachable (${alive.reason}). ` +
        `Confirm Vercel is up before attempting any recovery action.`,
    };
  }
  if (!audit.ok) {
    return {
      label: "AUDIT-FAILED",
      next:
        `The cohort audit script exited unexpectedly (status=${audit.exitCode}). ` +
        `Re-run \`node scripts/audit-peer-panels.mjs --verbose\` to diagnose ` +
        `before proceeding with the reset-day sequence.`,
    };
  }

  const polluted = audit.polluted;
  const pollutedCount = polluted.size;

  // Any pollution OUTSIDE the catalog is a fresh regression. Detect
  // it first so we don't mis-classify it as the standard recovery
  // path.
  const unknownPairs = [];
  if (!catalog.empty) {
    for (const [parent, dirtyTickers] of polluted) {
      const expected = KNOWN_PENDING_POLLUTION.get(parent);
      for (const t of dirtyTickers) {
        if (!expected || !expected.has(t)) {
          unknownPairs.push(`${parent.toUpperCase()}=${t}`);
        }
      }
    }
  } else if (pollutedCount > 0) {
    // Catalog already empty; any pollution is by definition outside.
    for (const [parent, dirtyTickers] of polluted) {
      for (const t of dirtyTickers) {
        unknownPairs.push(`${parent.toUpperCase()}=${t}`);
      }
    }
  }
  if (unknownPairs.length > 0) {
    return {
      label: "FRESH-REGRESSION",
      next:
        `Production has polluted peer rows that are NOT in the catalog: ` +
        `${unknownPairs.join(" ")}. This is a NEW pollution incident, not ` +
        `the standard recovery. Do not run \`recover-peer-pollution.yml\` ` +
        `with the default inputs. Diagnose first.`,
    };
  }

  // From here on, ALL pollution (if any) is inside the catalog.
  if (pollutedCount > 0 && !catalog.empty) {
    return {
      label: "PRE-RECOVERY",
      next:
        `Production still serves the known-pending pollution. If Neon Free ` +
        `quota has reset, trigger \`recover-peer-pollution.yml\` with the ` +
        `default inputs. If the workflow fails with phase=resolve_parents ` +
        `pg_code=XX000, the Neon quota has NOT reset yet — wait and re-` +
        `check. (Polluted parents: ${[...polluted.keys()].join(",")})`,
    };
  }

  // Audit clean from here on.
  if (!catalog.empty) {
    if (fixtures.available && fixtures.suspectsStillPresent.length > 0) {
      return {
        label: "RECOVERY-DONE-FIXTURES-STALE",
        next:
          `Production audit is clean, but the bundled fixtures still carry ` +
          `the suspect tickers (${fixtures.suspectsStillPresent
            .map((s) => `${s.parent.toUpperCase()}=[${s.tickers.join(",")}]`)
            .join(" ")}). Re-ingest the cohort from production and run ` +
          `\`npm run fixtures:freeze\` to regenerate the fixture set. The ` +
          `\`fixture-pollution.test.ts\` PRE-RECOVERY suite is still in ` +
          `force until you do.`,
      };
    }
    return {
      label: "FIXTURES-FRESH-CATALOG-STALE",
      next:
        `Production audit is clean AND fixtures no longer carry the catalog ` +
        `suspects. Retire the catalog: open ` +
        `\`scripts/lib/known-pending-pollution.mjs\` and replace ` +
        `\`KNOWN_PENDING_POLLUTION\` with \`new Map()\`. The fixture-` +
        `pollution test will flip to POST-RECOVERY mode automatically once ` +
        `the catalog is empty.`,
    };
  }

  // Catalog empty AND audit clean.
  return {
    label: "FULLY-CLEAN",
    next:
      `Recovery + refreeze + catalog retirement complete. No action. ` +
      `\`fixture-pollution.test.ts\` is in POST-RECOVERY mode and any new ` +
      `suspect ticker in fixtures will now flag as a fresh regression.`,
  };
}
