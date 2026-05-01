/**
 * Canonical-JSON + canonical-text rules for parity diffs.
 *
 * Codex flagged seven false-positive axes for byte-for-byte JSON diffs
 * (P1-1) plus CD&A text/html normalization noise (P1-2). This module
 * is the single source of truth for both:
 *
 *   - canonicalText(s)  — NFC-normalize + collapse whitespace runs
 *   - canonicalJson(v)  — sort keys, drop ignored fields, normalize NULL
 *                          vs undefined, format floats deterministically
 *   - structuralFingerprint(html) — tag-name multiset for HTML diffs
 *
 * Used by the comparator at src/lib/parity/comparator.ts. Pure
 * functions only — never mutate inputs.
 */
import { createHash } from "node:crypto";

/**
 * Fields that vary between Python and TS extractors but are not
 * semantically meaningful. Stripped from both sides before diff.
 */
export const IGNORED_FIELDS = new Set<string>([
  // Auto-incrementing primary keys differ between SQLite oracle and
  // future Postgres rewrite. Compare on natural-key fields instead.
  "id",
  "section_id",
  "peer_group_id",
  "document_id",
  // Audit timestamps
  "created_at",
  "updated_at",
]);

/**
 * Fields the comparator tolerates differing on, but reports separately.
 * E.g. a confidence_score of 0.97 vs 0.98 is uninteresting noise.
 */
export const TOLERATED_FIELDS = new Set<string>([
  "confidence_score",
  "resolution_confidence",
]);

/**
 * Round a float to 6 significant figures and emit a stable string. JS
 * `Number.toString` and Python `repr` differ at small values; this
 * neutralizes the difference for parity diff purposes.
 */
export function canonicalFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // toPrecision(6) gives "0.300000"; toFixed(6) gives "0.300000".
  // Use Number again to drop trailing zeros, then back to string.
  return String(Number.parseFloat(value.toPrecision(6)));
}

/**
 * Unicode NFC + whitespace collapse + trim. Used on `text`, source
 * excerpts, and any field where the Python BS4+lxml HTML→text path
 * may emit different whitespace from the TS cheerio path.
 */
export function canonicalText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\u00a0/g, " ") // NBSP
    .replace(/[\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SHA-256 hex digest of a string. Used as a fast-fail identity check
 * for large fields like CD&A text.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Tag-name multiset over an HTML fragment. Comparing the full HTML
 * across BS4+lxml and cheerio is hopelessly noisy (style attributes,
 * whitespace, self-closing differences). Comparing the tag name +
 * count multiset gives a coarse but stable structural fingerprint
 * that catches "section structure changed" without false-positiving
 * on serialization differences.
 */
export function structuralFingerprint(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const tagPattern = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)\b/g;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Stable JSON canonicalization. Sort keys, drop ignored fields, fold
 * undefined → null, format floats via canonicalFloat. Used as the
 * input to byte-for-byte fixture comparison.
 */
export function canonicalJson(value: unknown): unknown {
  return _canon(value, new Set());
}

function _canon(value: unknown, seen: Set<unknown>): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : canonicalFloat(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((v) => _canon(v, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new Error("canonicalJson: circular reference");
    }
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (IGNORED_FIELDS.has(key)) continue;
      out[key] = _canon(obj[key], seen);
    }
    return out;
  }
  return String(value);
}

/**
 * Compute the bytes-equal canonical JSON string. Use in fixture diffs
 * after both sides pass through `canonicalJson`.
 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}
