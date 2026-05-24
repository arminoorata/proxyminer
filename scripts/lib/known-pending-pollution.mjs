/**
 * Phase 24 — known-pending peer-panel pollution.
 *
 * Catalog of the cohort-pollution rows that are KNOWN to exist in
 * production but are pending recovery because of an EXTERNAL blocker
 * (Neon Free data-transfer quota exhaustion). The
 * `recover-peer-pollution.yml` workflow cannot run until the blocker
 * clears. Until then, the CI audit will detect these rows and fail
 * — but we want the failure annotated so an operator can tell
 * "external blocker still in effect" apart from "new pollution
 * appeared that we didn't expect."
 *
 * If `audit-peer-panels.mjs` sees ONLY pollution from this map, it
 * still exits non-zero (we do not silently pass real pollution) but
 * emits a single GitHub Actions `::warning::` annotation with the
 * reset-day pointer instead of letting the failure look like fresh
 * regression.
 *
 * If the audit sees a polluted (parent, ticker) pair NOT in this
 * map, that is a NEW regression — the warning is suppressed and the
 * failure stands on its own.
 *
 * ──────────────────────────────────────────────────────────────────
 * Phase 27 — LIFECYCLE
 *
 * This catalog is a state machine. The Map's emptiness is the toggle
 * between two regimes; flipping it is a deliberate operator action,
 * not a date-based event.
 *
 *   PRE-RECOVERY (current state, catalog non-empty)
 *     - Catalog lists every (parent, suspect) pair that production
 *       still serves and that the recovery workflow will delete.
 *     - The fixture-pollution test asserts THESE PAIRS ARE PRESENT
 *       in `.fixtures/by-filing/`. If they were missing while
 *       production still has them, CI would look green while
 *       /company/[id] (under fixture fallback) renders clean
 *       chips that don't match the live DB.
 *     - The audit annotates known-pending pollution as a
 *       `::warning::`. Unexpected pairs flip to `::error::`.
 *
 *   POST-RECOVERY (catalog empty)
 *     - Operator has executed the full reset-day sequence:
 *         1. `recover-peer-pollution.yml` ran cleanly.
 *         2. Cohort re-ingested via `recover-cohort.yml` (or admin
 *            ingest per company) so production DB carries the
 *            current extractor's output.
 *         3. `npm run fixtures:freeze` regenerated the bundled
 *            fixtures from the now-clean production filings.
 *         4. Operator emptied the Map below (the catalog
 *            retirement step — see docs/recovery.md).
 *     - The fixture-pollution test FLIPS its expectation: any
 *       suspect-shaped ticker in any cohort parent's fixture
 *       peer rows is now a regression, not a known-pending row.
 *     - The audit returns to plain ::error:: framing on any
 *       pollution it detects.
 *
 * Do NOT empty this Map before the four operator steps above have
 * been completed in order. The fixture-pollution test will refuse
 * to assert clean fixtures unless the catalog itself is empty —
 * that's the safety interlock.
 *
 * See `npm run recovery:reset-day-check` for a single command that
 * detects which state we're in and prints the next action.
 */

/**
 * Map from parent ticker (lowercase) → Set of suspect peer tickers
 * (uppercase, as stored in `peer_group_members.ticker_resolved`).
 *
 * To retire (post-recovery, post-refreeze, see lifecycle above):
 * replace this Map with `new Map()`. Do NOT leave it half-empty.
 * `isCatalogEmpty()` is the single predicate every consumer reads;
 * a Map with all-empty Sets would slip past a `size > 0` check
 * elsewhere otherwise.
 */
export const KNOWN_PENDING_POLLUTION = new Map([
  ["crm", new Set(["HEPS", "KFII", "TBTC", "FIVE", "ABVE"])],
  ["nflx", new Set(["HEPS", "SFWJ"])],
  ["qcom", new Set(["HEPS"])],
]);

/**
 * Phase 27 — canonical "are we in pre-recovery state?" predicate.
 *
 * Returns true while the catalog has at least one (parent, suspect)
 * pair to recover. Used by:
 *   - src/lib/data/fixture-pollution.test.ts (flips its assertion)
 *   - scripts/recovery-reset-day-check.mjs (state machine)
 *
 * Counts SUSPECTS, not parent keys, so an accidental
 * `new Map([["crm", new Set()]])` reads as empty (the safe answer).
 */
export function isCatalogEmpty() {
  for (const suspects of KNOWN_PENDING_POLLUTION.values()) {
    if (suspects.size > 0) return false;
  }
  return true;
}

/**
 * Human-readable label for when the external blocker is expected to
 * clear. The audit emits this in the GitHub Actions annotation so the
 * operator sees a target date instead of "wait indefinitely."
 */
export const RESET_ETA_LABEL = "2026-06-01";

/**
 * The blocker description that goes into the annotation. Keep it
 * short and operator-facing.
 */
export const BLOCKER_DESCRIPTION =
  "Neon Free data-transfer quota exhausted; DB-only recovery blocked until reset";

/**
 * @typedef {{ ticker: string, dirty: { ticker: string }[] }} AuditResultLike
 */

/**
 * Classify a list of audit results as "matches known-pending set" or
 * not. Pure function — no I/O.
 *
 * @param {AuditResultLike[]} results — only the rows the caller has
 *        already filtered down to "polluted" verdicts.
 * @returns {{
 *   allKnown: boolean,
 *   knownMatches: { parent: string, tickers: string[] }[],
 *   unknownPairs: { parent: string, ticker: string }[],
 *   missingExpected: { parent: string, tickers: string[] }[],
 * }}
 */
export function classifyKnownPendingPollution(results) {
  const knownMatches = [];
  const unknownPairs = [];

  // Track which expected (parent, suspect) pairs were NOT seen in
  // this audit so the caller can detect partial recovery (e.g. one
  // parent cleaned up but others still pending).
  const expectedRemaining = new Map();
  for (const [parent, suspectSet] of KNOWN_PENDING_POLLUTION) {
    expectedRemaining.set(parent, new Set(suspectSet));
  }

  for (const r of results) {
    const parent = (r.ticker ?? "").toLowerCase();
    const dirtyTickers = (r.dirty ?? []).map((d) => d.ticker);
    const expectedForParent = KNOWN_PENDING_POLLUTION.get(parent);

    const matchedForThisParent = [];
    for (const t of dirtyTickers) {
      if (expectedForParent && expectedForParent.has(t)) {
        matchedForThisParent.push(t);
        expectedRemaining.get(parent).delete(t);
      } else {
        unknownPairs.push({ parent, ticker: t });
      }
    }
    if (matchedForThisParent.length > 0) {
      knownMatches.push({ parent, tickers: matchedForThisParent });
    }
  }

  const missingExpected = [];
  for (const [parent, remaining] of expectedRemaining) {
    if (remaining.size > 0) {
      missingExpected.push({ parent, tickers: [...remaining].sort() });
    }
  }

  return {
    allKnown: unknownPairs.length === 0 && knownMatches.length > 0,
    knownMatches,
    unknownPairs,
    missingExpected,
  };
}

/**
 * Render the GitHub Actions annotation text for the audit log when
 * all detected pollution falls inside `KNOWN_PENDING_POLLUTION`.
 *
 * Returns the literal string that should be emitted; use one of
 * `::warning::` or `::notice::` depending on whether the failure
 * exits 1. Caller wraps with the marker.
 */
export function formatKnownPendingAnnotationBody(classification) {
  if (!classification.allKnown) {
    return null;
  }
  const parts = classification.knownMatches
    .map(({ parent, tickers }) => `${parent.toUpperCase()}=[${tickers.sort().join(",")}]`)
    .join(" ");
  return (
    `${BLOCKER_DESCRIPTION}. ` +
    `Detected pollution matches the known-pending set exactly: ${parts}. ` +
    `Next eligible recovery date: ${RESET_ETA_LABEL}. ` +
    `Run docs/recovery.md → "June 1 reset checklist" once the blocker clears. ` +
    `This CI failure does NOT indicate a fresh regression.`
  );
}
