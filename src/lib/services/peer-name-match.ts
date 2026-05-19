/**
 * Match peer-group member names against the SEC ticker universe.
 *
 * Filings render peer companies as prose names ("Acuity Brands, Inc.",
 * "Illinois Tool Works Inc.", "Berkshire Hathaway Inc."), and our
 * extractor preserves them as-is. To turn each peer into a navigable
 * link we need to resolve those names to SEC tickers — which is the
 * shape the in-memory cache already exposes.
 *
 * Strategy: normalize both sides (lowercase, strip trailing corporate
 * suffixes, strip punctuation, collapse whitespace), then exact-match.
 * No fuzzy/Levenshtein — peer names in filings are clean enough that
 * after canonicalization they match SEC's title field directly, and a
 * loose matcher would silently mislink companies (e.g. "Apple Hospitality"
 * vs "Apple Inc.").
 */
import type { SecTickerEntry } from "./sec-tickers-cache";

/** Suffix tokens we strip off the END of a company name during
 * normalization. Order matters: longer multi-word forms first so they
 * don't get partially eaten by a shorter pattern. */
const TRAILING_SUFFIXES = [
  "incorporated",
  "corporation",
  "limited",
  "holdings",
  "holding",
  "company",
  "companies",
  "international",
  "group",
  "& co",
  "and co",
  "plc",
  "llc",
  "ltd",
  "inc",
  "corp",
  "co",
  "sa",
  "nv",
  "ag",
];

/** Patterns whose ENTIRE parenthetical content should be dropped
 * before normalization. PSA-style peer rows render as
 * "Welltower Inc. (NYSE: WELL)" / "Equinix, Inc. (Nasdaq: EQIX)"
 * — the exchange-ticker parenthetical doesn't appear in SEC's title
 * index and breaks exact matching. */
const EXCHANGE_PAREN_PATTERN =
  /\((?:NYSE|NASDAQ|NSE|AMEX|OTC|TSX|LSE|TSE|OTCBB|OTCQB|OTCQX)\s*[:.-]?\s*[A-Z0-9.\-]{1,8}\)/gi;

export function normalizePeerName(raw: string): string {
  if (!raw) return "";
  // Drop exchange-ticker parentheticals BEFORE the punctuation strip,
  // since they ride a `(NYSE: ABC)` structure that the bulk strip
  // would expose as a noisy "nyse abc" token suffix.
  let s = raw.replace(EXCHANGE_PAREN_PATTERN, " ").toLowerCase();
  // Strip everything that isn't alphanumeric or whitespace.
  s = s.replace(/[^a-z0-9\s]/g, " ");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Trim trailing corporate suffixes, repeatedly (handles "Apple Inc.
  // Holdings" → "apple").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of TRAILING_SUFFIXES) {
      if (s === suffix) {
        // The whole string is just a suffix — bail with empty so we
        // don't false-match against another bare suffix in the SEC
        // universe.
        return "";
      }
      const withSpace = ` ${suffix}`;
      if (s.endsWith(withSpace)) {
        s = s.slice(0, -withSpace.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

export interface MatchedPeer {
  ticker: string;       // SEC's canonical ticker form
  cik: string;
  name: string;         // SEC's title
  company_id: string;   // lowercase ticker — our DB key
}

/** Build a lookup index from normalized SEC title → ticker entry.
 * Called once per request; cheap (13k strings). */
export function buildSecNameIndex(
  entries: readonly SecTickerEntry[],
): Map<string, SecTickerEntry> {
  const idx = new Map<string, SecTickerEntry>();
  for (const e of entries) {
    const norm = normalizePeerName(e.name);
    if (!norm) continue;
    // First write wins. Duplicate normalized names (e.g. BRK-A and
    // BRK-B both normalize to "berkshire hathaway") get the first one;
    // both are the same underlying company so either link is fine.
    if (!idx.has(norm)) idx.set(norm, e);
  }
  return idx;
}

export function matchPeerNameToSec(
  rawName: string,
  index: ReadonlyMap<string, SecTickerEntry>,
): MatchedPeer | null {
  const norm = normalizePeerName(rawName);
  if (!norm) return null;
  const hit = index.get(norm);
  if (!hit) return null;
  return {
    ticker: hit.ticker,
    cik: hit.cik,
    name: hit.name,
    company_id: hit.ticker_lower,
  };
}
