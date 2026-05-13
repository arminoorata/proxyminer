/**
 * Sentence-level inline diff for two CD&A texts.
 *
 *   `oldText` — prior-year CD&A
 *   `newText` — current-year CD&A
 *
 * Output is a sequence of operations in the order they appear in the
 * NEW filing's sentence stream, plus the trailing list of removed
 * sentences that don't have a natural anchor in the new doc:
 *
 *   { type: "unchanged",  newText, oldText }
 *   { type: "added",      newText }
 *   { type: "changed",    newText, oldText, wordDiff: [...] }
 *   { type: "removed",    oldText }
 *
 * For "changed" pairs (a removed sentence and an added sentence with
 * high lexical overlap), we also produce a word-level diff so the
 * UI can highlight which tokens shifted.
 *
 * Tradeoffs:
 *   - Sentence tokenization uses a small abbreviation list (Mr., Ms.,
 *     Inc., U.S., etc.) so dotted phrases don't split mid-sentence.
 *     It's not perfect but good enough for prose CD&A.
 *   - Matching is normalized (whitespace collapsed, lowercased) so
 *     a re-typeset sentence with the same words counts as unchanged.
 *   - "Changed" detection uses bigram Jaccard ≥ 0.5; sentences below
 *     that threshold stay separately classified as added/removed.
 *   - Complexity is O(n + m) for the set diff and O(k*r) for changed
 *     pairing where k=added count, r=removed count. CD&A texts are
 *     ~500 sentences max so this finishes in single-digit ms.
 */

export type InlineDiffOp =
  | { type: "unchanged"; newText: string; oldText: string }
  | { type: "added"; newText: string }
  | { type: "changed"; newText: string; oldText: string; wordDiff: WordOp[] }
  | { type: "removed"; oldText: string };

export type WordOp =
  | { type: "same"; text: string }
  | { type: "ins"; text: string }
  | { type: "del"; text: string };

export interface InlineDiffResult {
  /** Operations in the new-document sentence order. */
  ops: InlineDiffOp[];
  /** Old-only sentences that weren't matched to a "changed" pair. */
  removed: string[];
  /** Counts for headline display. */
  counts: {
    unchanged: number;
    added: number;
    removed: number;
    changed: number;
  };
}

// ── Tokenization ─────────────────────────────────────────────────────

// Common abbreviations whose trailing period must NOT end a sentence.
// Kept short — adding too many risks merging real sentence breaks.
const ABBREV = new Set([
  "Mr", "Mrs", "Ms", "Dr", "St", "Inc", "Ltd", "Corp", "Co", "LLC",
  "LP", "LLP", "Jr", "Sr", "Bros", "Ph", "U.S", "U.K", "vs", "etc",
  "e.g", "i.e", "No", "Nos", "et", "al", "approx", "Reg",
]);

/**
 * Split CD&A prose into sentences. Returns an array of raw sentences
 * (preserving original whitespace and capitalization for display).
 */
export function splitIntoSentences(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  // Normalize line breaks but keep paragraph context.
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
  // Split into paragraphs first (double newlines), then sentence-tokenize
  // each paragraph. Paragraph breaks are also sentence breaks.
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const collapsed = trimmed.replace(/\s+/g, " ");
    let buf = "";
    for (let i = 0; i < collapsed.length; i++) {
      const c = collapsed[i];
      buf += c;
      if (c !== "." && c !== "!" && c !== "?") continue;
      // The next char must be whitespace or end of string for this
      // to be a sentence terminator.
      const next = collapsed[i + 1];
      if (next !== undefined && next !== " ") continue;
      // Check the preceding token isn't an abbreviation.
      const back = buf.slice(0, -1);
      const tokenMatch = /([A-Za-z][A-Za-z.]*)$/.exec(back);
      const tok = tokenMatch?.[1] ?? "";
      if (tok && ABBREV.has(tok.replace(/\.$/, ""))) continue;
      // Don't split a decimal number ("$3.5 million" — the . is between
      // digits). Look back further for [0-9].[0-9] form.
      if (
        /\d$/.test(back) &&
        next !== undefined &&
        /\d/.test(collapsed[i - 1] ?? "")
      ) {
        // Actually we want to skip when the .'s neighbors are digits.
        // Re-check: the current char is "." (or !?). For !/? it's
        // never a decimal. For ".": is the previous char a digit AND
        // the next char a digit? Then skip.
        if (
          c === "." &&
          /\d/.test(collapsed[i - 1] ?? "") &&
          /\d/.test(collapsed[i + 1] ?? "")
        ) {
          continue;
        }
      }
      const sentence = buf.trim();
      if (sentence) out.push(sentence);
      buf = "";
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
  }
  return out;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Word-shingle set. Uses unigrams because CD&A sentences are often
 * short (10-15 words) — bigrams alone give too few signals and a
 * single-word swap drops Jaccard below the 0.5 "changed" threshold.
 * Unigrams over short sentences correctly classify "We rely on three
 * pillars." vs "We rely on four pillars." as a "changed" pair.
 */
function shingleSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

// ── Word-level diff (LCS) ────────────────────────────────────────────

/**
 * Simple LCS-based word diff. O(n*m) — fine for sentence-length input
 * (rarely > 60 words).
 */
export function wordDiff(oldText: string, newText: string): WordOp[] {
  const a = oldText.split(/\s+/).filter(Boolean);
  const b = newText.split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  // LCS table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (normalizeForMatch(a[i - 1]) === normalizeForMatch(b[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack.
  const ops: WordOp[] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (normalizeForMatch(a[i - 1]) === normalizeForMatch(b[j - 1])) {
      ops.push({ type: "same", text: b[j - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "del", text: a[i - 1] });
      i--;
    } else {
      ops.push({ type: "ins", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: "del", text: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ type: "ins", text: b[j - 1] }); j--; }
  return ops.reverse();
}

// ── Top-level diff ───────────────────────────────────────────────────

const CHANGED_THRESHOLD = 0.5;

export function diffCdaSentences(
  oldText: string,
  newText: string,
): InlineDiffResult {
  const oldSentences = splitIntoSentences(oldText);
  const newSentences = splitIntoSentences(newText);

  // Index old sentences by normalized form for O(1) match lookup.
  const oldByNormalized = new Map<string, number[]>();
  for (let i = 0; i < oldSentences.length; i++) {
    const key = normalizeForMatch(oldSentences[i]);
    const arr = oldByNormalized.get(key);
    if (arr) arr.push(i);
    else oldByNormalized.set(key, [i]);
  }

  const matchedOldIndices = new Set<number>();
  // First pass: walk new sentences, mark each as added or unchanged.
  // Defer the "changed" detection to the second pass.
  type PassOne =
    | { type: "unchanged"; newText: string; oldText: string }
    | { type: "added"; newText: string };
  const passOne: PassOne[] = [];
  for (const sentence of newSentences) {
    const key = normalizeForMatch(sentence);
    const candidates = oldByNormalized.get(key);
    let matched: number | null = null;
    if (candidates) {
      for (const idx of candidates) {
        if (!matchedOldIndices.has(idx)) {
          matched = idx;
          break;
        }
      }
    }
    if (matched !== null) {
      matchedOldIndices.add(matched);
      passOne.push({
        type: "unchanged",
        newText: sentence,
        oldText: oldSentences[matched],
      });
    } else {
      passOne.push({ type: "added", newText: sentence });
    }
  }

  // Old sentences not yet matched.
  const unmatchedOldIndices: number[] = [];
  for (let i = 0; i < oldSentences.length; i++) {
    if (!matchedOldIndices.has(i)) unmatchedOldIndices.push(i);
  }

  // Second pass: try to pair "added" entries with unmatched old
  // sentences when their bigram similarity is high enough. The pair
  // becomes a "changed" entry.
  const oldShingles = new Map<number, Set<string>>();
  for (const i of unmatchedOldIndices) {
    oldShingles.set(i, shingleSet(normalizeForMatch(oldSentences[i])));
  }
  const consumedOld = new Set<number>();
  const ops: InlineDiffOp[] = [];
  for (const entry of passOne) {
    if (entry.type !== "added") {
      ops.push(entry);
      continue;
    }
    const ab = shingleSet(normalizeForMatch(entry.newText));
    let bestIdx: number | null = null;
    let bestScore = CHANGED_THRESHOLD;
    for (const oi of unmatchedOldIndices) {
      if (consumedOld.has(oi)) continue;
      const score = jaccard(ab, oldShingles.get(oi)!);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = oi;
      }
    }
    if (bestIdx !== null) {
      consumedOld.add(bestIdx);
      const oldSentence = oldSentences[bestIdx];
      ops.push({
        type: "changed",
        newText: entry.newText,
        oldText: oldSentence,
        wordDiff: wordDiff(oldSentence, entry.newText),
      });
    } else {
      ops.push(entry);
    }
  }

  // Truly removed: unmatched old sentences not paired into a "changed".
  const removed: string[] = [];
  for (const i of unmatchedOldIndices) {
    if (!consumedOld.has(i)) removed.push(oldSentences[i]);
  }

  // Counts.
  let unchangedC = 0,
    addedC = 0,
    changedC = 0;
  for (const op of ops) {
    if (op.type === "unchanged") unchangedC++;
    else if (op.type === "added") addedC++;
    else if (op.type === "changed") changedC++;
  }
  return {
    ops,
    removed,
    counts: {
      unchanged: unchangedC,
      added: addedC,
      removed: removed.length,
      changed: changedC,
    },
  };
}
