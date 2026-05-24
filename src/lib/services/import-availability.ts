/**
 * Phase 22: classify import availability + ingest failure shape.
 *
 * Two pure helpers shared by the UI and the public-ingest route so
 * the same rules apply in `TickerAutocomplete`, `ImportRunner`, and
 * tests:
 *
 *   - `classifyImportAvailability` decides whether a search hit can
 *     be navigated to. When the SEC ticker universe is degraded
 *     (live SEC fetch failed → bundled fallback), tickers that
 *     aren't already in ProxyMiner are NOT importable. Routing such
 *     a click into `/import/[ticker]` would queue a job that's
 *     guaranteed to fail with `sec_fetch_failed` (or worse, hit the
 *     Vercel data-transfer quota and surface as a generic 500).
 *
 *   - `classifyImportError` maps the ingest worker's failure modes
 *     into three buckets the UI cares about: platform quota, transient
 *     SEC, or other. Platform-quota failures hide the Retry button
 *     since retrying can't fix the quota.
 */
export type ImportAvailability = "available" | "in_db" | "unavailable_degraded";

export interface SearchHitLike {
  in_db: boolean;
}

export function classifyImportAvailability(
  hit: SearchHitLike,
  degraded: boolean,
): ImportAvailability {
  if (hit.in_db) return "in_db";
  if (degraded) return "unavailable_degraded";
  return "available";
}

export type ImportErrorKind = "platform_quota" | "sec_transient" | "other";

const PLATFORM_QUOTA_PATTERNS = [
  /data transfer quota/i,
  /exceeded the data transfer/i,
  /data_transfer_quota/i,
];

export function isPlatformQuotaMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return PLATFORM_QUOTA_PATTERNS.some((re) => re.test(message));
}

export interface ImportErrorLike {
  code: string | null | undefined;
  message: string | null | undefined;
}

export function classifyImportError(err: ImportErrorLike): ImportErrorKind {
  if (err.code === "platform_quota_exceeded") return "platform_quota";
  if (isPlatformQuotaMessage(err.message)) return "platform_quota";
  if (err.code === "sec_fetch_failed") return "sec_transient";
  return "other";
}

export const PLATFORM_QUOTA_MESSAGE =
  "SEC imports are temporarily unavailable because the deployment has exhausted its data-transfer quota. Existing ProxyMiner companies still work.";

/**
 * Phase 26 a11y helper — build the screen-reader-visible label for
 * an autocomplete option that combines ticker, name, AND availability
 * status in one announcement. Without this, a screen-reader user
 * tabbing the listbox hears only the visible text and has no way to
 * tell why Enter is a no-op on certain rows under degraded mode.
 */
export interface AutocompleteHitLabel {
  ticker: string;
  name: string;
}

export function buildAutocompleteAriaLabel(
  hit: AutocompleteHitLabel,
  availability: ImportAvailability,
): string {
  switch (availability) {
    case "unavailable_degraded":
      return `${hit.ticker} ${hit.name}, unavailable — SEC imports are paused.`;
    case "in_db":
      return `${hit.ticker} ${hit.name}, in ProxyMiner. Press Enter to open.`;
    case "available":
      return `${hit.ticker} ${hit.name}, not yet in ProxyMiner. Press Enter to import from SEC.`;
  }
}
