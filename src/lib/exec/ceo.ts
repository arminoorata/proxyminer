/**
 * Single source of truth for "is this executive the CEO?".
 *
 * Filings disclose the role in highly variable phrasing:
 *   - "Chief Executive Officer"
 *   - "President and Chief Executive Officer"
 *   - "President and CEO"                          (CEO as acronym only)
 *   - "Chairman, President and CEO"
 *   - "Chair of the Board and CEO"                 (ADBE)
 *   - "Co-CEO"
 *
 * Earlier code used `/\bexecutive\s+officer\b/i` which missed any
 * filing where CEO appears only as an acronym (AYI, NVDA, KEY, etc.).
 * It also matched "Executive Officer" as a generic phrase, which
 * could swallow non-CEO rows.
 *
 * `isCeoPosition()` now accepts:
 *   - the full phrase "Chief Executive Officer"
 *   - the acronym "CEO" surrounded by word boundaries
 *   - "Co-CEO" / "Co CEO"
 * and rejects:
 *   - "Deputy CEO" / "Former CEO" / "Interim Co-CEO" (could be added
 *     later; for now we accept these because some filings legitimately
 *     surface an interim CEO row that's the one analysts care about
 *     for that filing year)
 *   - Plain "Executive Officer" (without "Chief" or "CEO" anywhere)
 *     — that's a generic NEO row, not the CEO.
 */

const CEO_PHRASE = /\bchief\s+executive\s+officer\b/i;
const CEO_ACRONYM = /(?<![A-Z])CEO(?![A-Z])/;
// "Co-CEO" / "Co CEO" / "co-chief executive officer"
const CO_CEO = /\bco[\s-]?(?:ceo\b|chief\s+executive\s+officer\b)/i;

export function isCeoPosition(position: string | null | undefined): boolean {
  if (!position) return false;
  if (CEO_PHRASE.test(position)) return true;
  if (CO_CEO.test(position)) return true;
  // CEO acronym match. CEO_ACRONYM is case-sensitive to avoid matching
  // strings like "Receo..." which would happen with /i. Filings
  // capitalise CEO consistently as uppercase.
  if (CEO_ACRONYM.test(position)) return true;
  return false;
}
