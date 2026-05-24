/**
 * Phase 30 — pure helpers for source-text snippet highlighting in
 * SearchView. JSX rendering stays in the component; the split logic
 * lives here so vitest covers every edge case (multi-match,
 * regex-meta queries, case-insensitive matching, empty query)
 * without a DOM.
 */

/**
 * Escape regex metacharacters so a user-typed query is safe to
 * splice into a `new RegExp(...)`. Without this, a query like `(a)`
 * builds an invalid regex and the highlight pass throws or matches
 * incorrectly.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SnippetPart {
  text: string;
  isMatch: boolean;
}

/**
 * Split a snippet into alternating literal-text and match-text parts
 * so the caller can render each match-text in a `<mark>`. Matches are
 * case-insensitive and preserve the original casing in the snippet.
 *
 * Contract:
 *   - empty query → one part, `isMatch: false`, full snippet
 *   - no match in snippet → one part, `isMatch: false`, full snippet
 *   - multiple matches → alternating parts, starting with non-match
 *     (which may be empty if the snippet starts with a match)
 *   - regex-meta chars in `q` (like `(`, `.`, `?`) are escaped so a
 *     literal-string match still works
 */
export function splitSnippetForHighlight(
  snippet: string,
  q: string,
): SnippetPart[] {
  if (!q) return [{ text: snippet, isMatch: false }];
  const escaped = escapeRegex(q);
  const parts = snippet.split(new RegExp(`(${escaped})`, "ig"));
  const qLower = q.toLowerCase();
  return parts.map((text) => ({
    text,
    isMatch: text.toLowerCase() === qLower,
  }));
}
