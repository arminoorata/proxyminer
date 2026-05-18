/**
 * Shared ticker shape gate used by the public ingest route and the
 * /import/[ticker] page. SEC tickers are 1–5 letters in the common
 * case; we widen to 8 chars to cover dual-class share suffixes
 * (BRK.A, BRK.B) and the rare alphanumeric form. We deliberately
 * reject queries that look like full company names ("Apple Inc.")
 * — the home-page search handles those.
 */
export const TICKER_PATTERN = /^[A-Za-z][A-Za-z0-9.\-]{0,7}$/;

export function isValidTickerShape(input: string | null | undefined): boolean {
  if (!input) return false;
  return TICKER_PATTERN.test(input.trim());
}

export function normalizeTickerForDb(input: string): string {
  return input.trim().toLowerCase();
}
