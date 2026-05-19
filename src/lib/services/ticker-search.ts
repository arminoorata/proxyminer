/**
 * Ranked matching over the SEC ticker universe for autocomplete.
 *
 * Ranking (best first):
 *   1. Exact ticker match              — score 1000
 *   2. Ticker prefix match             — score 900 - len_delta
 *   3. Word-boundary name match        — score 700 - position
 *   4. Substring name match            — score 500 - position
 *   5. Substring ticker match (rare)   — score 400
 *
 * Pure function: takes a query string + the in-memory SEC entries +
 * a Set of company IDs already in the ProxyMiner DB. Returns the top
 * N matches. Tests pin the ranking behavior; the API route just wires
 * this into HTTP + the SEC cache.
 */
import type { SecTickerEntry } from "./sec-tickers-cache";

export interface TickerSearchHit {
  ticker: string;          // SEC's official case (e.g. "AAPL", "BRK.A")
  name: string;            // SEC's company title
  cik: string;             // padded 10-char CIK
  in_db: boolean;          // already imported into ProxyMiner
  company_id: string;      // ticker lowercased — matches our DB id convention
  score: number;           // ranking score; higher is better
  match_reason: MatchReason;
}

export type MatchReason =
  | "ticker_exact"
  | "ticker_prefix"
  | "name_word"
  | "name_substring"
  | "ticker_substring";

export interface TickerSearchOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 10;

/**
 * Normalize a ticker for class-share matching. SEC's
 * company_tickers.json uses `-` as the dual-class delimiter
 * (e.g. "BRK-A", "BF-B"). Analysts commonly type the `.` form
 * (BRK.A, BF.B) because that's how Bloomberg and most newswire
 * services format them. Collapsing both to a single canonical
 * form lets either input land the hit.
 */
function canonTicker(s: string): string {
  return s.replace(/\./g, "-");
}

export function searchTickers(
  query: string,
  entries: readonly SecTickerEntry[],
  importedCompanyIds: ReadonlySet<string>,
  opts: TickerSearchOptions = {},
): TickerSearchHit[] {
  const qRaw = query.trim().toLowerCase();
  if (qRaw.length < 1) return [];
  const q = canonTicker(qRaw);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const hits: TickerSearchHit[] = [];

  for (const entry of entries) {
    let score = 0;
    let reason: MatchReason | null = null;
    const tickerCanon = canonTicker(entry.ticker_lower);

    if (tickerCanon === q) {
      score = 1000;
      reason = "ticker_exact";
    } else if (tickerCanon.startsWith(q)) {
      const lenDelta = tickerCanon.length - q.length;
      score = 900 - lenDelta;
      reason = "ticker_prefix";
    } else {
      // Try name word-boundary first (highest of the name matches),
      // then plain substring on either name or ticker as a fallback.
      const nameWordIdx = indexOfWordBoundary(entry.name_lower, q);
      if (nameWordIdx !== -1) {
        score = 700 - Math.min(nameWordIdx, 200);
        reason = "name_word";
      } else {
        const nameIdx = entry.name_lower.indexOf(q);
        if (nameIdx !== -1) {
          score = 500 - Math.min(nameIdx, 200);
          reason = "name_substring";
        } else if (tickerCanon.includes(q)) {
          score = 400;
          reason = "ticker_substring";
        }
      }
    }

    if (reason) {
      const company_id = entry.ticker_lower;
      hits.push({
        ticker: entry.ticker,
        name: entry.name,
        cik: entry.cik,
        in_db: importedCompanyIds.has(company_id),
        company_id,
        score,
        match_reason: reason,
      });
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tie-breaker: imported first (analyst wants to land on
    // existing data when both options are available), then by name.
    if (a.in_db !== b.in_db) return a.in_db ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return hits.slice(0, limit);
}

function indexOfWordBoundary(haystack: string, needle: string): number {
  if (haystack.startsWith(needle)) return 0;
  let from = 0;
  while (from < haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    const prev = haystack.charAt(idx - 1);
    if (prev === " " || prev === "-" || prev === "&" || prev === "/") {
      return idx;
    }
    from = idx + 1;
  }
  return -1;
}
