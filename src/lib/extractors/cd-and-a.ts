/**
 * CD&A section extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/extractor.py
 *
 * Strategy (mirrors the Python implementation 1:1):
 *
 *   1. Find a heading node whose text fullmatches the CD&A pattern.
 *      Scan h1-h4, p, div, b, span, td. Reject nodes inside <a> or
 *      <table>. Sort candidates by tag priority then text length.
 *   2. Fallback to a TOC anchor: <a href="#X">Compensation Discussion
 *      and Analysis</a>, resolve target id.
 *   3. Collect content from the heading's siblings (block-level tags).
 *   4. If sibling collection is < MIN_SECTION_CHARS_FOR_FALLBACK, also
 *      try a document-flow walk (find_all_next equivalent) and use it
 *      if it's > 1000 chars longer.
 *   5. Stop when we hit a known section-end heading after collecting
 *      ≥ MIN_SECTION_END_CHARS.
 *
 * Memory note (April 2026 OOM lesson): cheerio doesn't share BS4's
 * decompose-required cleanup, but we still avoid retaining the parsed
 * tree by returning early and letting GC handle it.
 */
import {
  extractSection,
  fullMatch,
  loadHtml,
  type ExtractedSection,
} from "./section-helpers";

export const CDA_EXTRACTOR_VERSION = "cda_extractor.ts.v1";

const CDA_PATTERN = /^compensation\s*discussion\s*(?:and|&)\s*analysis$/i;

const SECTION_END_PATTERNS: RegExp[] = [
  /^(?:people and )?compensation committee report$/i,
  /^summary compensation table$/i,
  /^pay versus performance$/i,
  /^grants of plan-based awards$/i,
  /^option exercises and stock vested$/i,
];

const SKIP_BLOCK_PATTERNS: RegExp[] = [
  /^table of contents$/i,
  /^\d{4}\s+proxy statement(?:\s*\|\s*\d+)?$/i,
  /^(?:summary\s+)?governance(?:\s+directors)?\s+compensation\s+proposals\s+other information$/i,
];

const MIN_SECTION_END_CHARS = 4_000;
const MIN_SECTION_CHARS_FOR_FALLBACK = 5_000;

export type { ExtractedSection };

export function extractCdAndA(html: string): ExtractedSection | null {
  const $ = loadHtml(html);
  if (!$) return null;
  const result = extractSection($, {
    matchesHeading: (text) => CDA_PATTERN.test(text),
    isSectionEnd: (text, collectedChars) => {
      if (collectedChars < MIN_SECTION_END_CHARS) return false;
      if (text.length > 160) return false;
      return SECTION_END_PATTERNS.some((p) => fullMatch(p, text));
    },
    shouldSkipBlock: (text) => SKIP_BLOCK_PATTERNS.some((p) => fullMatch(p, text)),
    minSectionEndChars: MIN_SECTION_END_CHARS,
    minSectionCharsForFallback: MIN_SECTION_CHARS_FOR_FALLBACK,
  });
  return result;
}
