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
 */

/**
 * Map from parent ticker (lowercase) → Set of suspect peer tickers
 * (uppercase, as stored in `peer_group_members.ticker_resolved`).
 */
export const KNOWN_PENDING_POLLUTION = new Map([
  ["crm", new Set(["HEPS", "KFII", "TBTC", "FIVE", "ABVE"])],
  ["nflx", new Set(["HEPS", "SFWJ"])],
  ["qcom", new Set(["HEPS"])],
]);

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
