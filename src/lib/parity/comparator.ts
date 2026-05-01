/**
 * Parity diff harness. Compares a TS extractor output against the
 * frozen Python oracle (`.fixtures/by-filing/<company>/<filing>/...`).
 *
 * Codex P0-1 + P1-7. The harness:
 *   - canonicalizes both sides via canonical.ts before diffing
 *   - skips IGNORED_FIELDS (autoinc IDs, timestamps)
 *   - reports TOLERATED_FIELDS (e.g. confidence_score) as warnings
 *   - tags exec-comp diffs with a `python-mirror` provenance flag so
 *     the test reporter can escalate them differently from
 *     hand-curated truth diffs
 *   - emits a structured DiffReport rather than a raw text diff
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  IGNORED_FIELDS,
  TOLERATED_FIELDS,
  canonicalJson,
  canonicalText,
  sha256Hex,
} from "./canonical";

export type FixtureKind =
  | "sections"
  | "executive_comp"
  | "peer_groups"
  | "policy_facts"
  | "metric_facts";

export type FixtureProvenance = "truth" | "python-mirror";

export interface DiffEntry {
  path: string; // dotted JSON path to the differing leaf
  oracle: unknown;
  candidate: unknown;
  severity: "regression" | "warning";
  field: string;
}

export interface DiffReport {
  kind: FixtureKind;
  provenance: FixtureProvenance;
  filing_dir: string;
  match: boolean;
  regressions: DiffEntry[];
  warnings: DiffEntry[];
  oracle_count: number;
  candidate_count: number;
  text_sha_changes: { path: string; oracle: string; candidate: string }[];
}

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

export function loadOracle(
  companyId: string,
  filingId: string,
  kind: FixtureKind,
): unknown {
  const path = join(FIXTURES_ROOT, companyId, filingId, `${kind}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Walk two values in lock-step. For arrays, compare by index; for
 * objects, compare by sorted keys. Difference accumulators are mutated
 * via closure for speed.
 */
function walk(
  oracle: unknown,
  candidate: unknown,
  path: string,
  diffs: DiffEntry[],
  warns: DiffEntry[],
  textShas: DiffReport["text_sha_changes"],
): void {
  if (oracle === candidate) return;

  // Both null/undefined → equal after canonicalization.
  if (oracle == null && candidate == null) return;

  if (typeof oracle === "string" && typeof candidate === "string") {
    // Heuristic: large text fields (>200 chars) get the canonicalText
    // treatment. Mismatches are reported with SHA digests so the test
    // log isn't spammed with 50KB of CD&A.
    if (oracle.length > 200 || candidate.length > 200) {
      const a = canonicalText(oracle);
      const b = canonicalText(candidate);
      if (a !== b) {
        textShas.push({
          path,
          oracle: sha256Hex(a),
          candidate: sha256Hex(b),
        });
        diffs.push({
          path,
          oracle: `<${oracle.length} chars sha=${sha256Hex(a).slice(0, 8)}>`,
          candidate: `<${candidate.length} chars sha=${sha256Hex(b).slice(0, 8)}>`,
          severity: "regression",
          field: leafField(path),
        });
      }
      return;
    }
  }

  if (Array.isArray(oracle) && Array.isArray(candidate)) {
    const max = Math.max(oracle.length, candidate.length);
    for (let i = 0; i < max; i++) {
      walk(oracle[i], candidate[i], `${path}[${i}]`, diffs, warns, textShas);
    }
    return;
  }

  if (
    oracle != null &&
    candidate != null &&
    typeof oracle === "object" &&
    typeof candidate === "object"
  ) {
    const keys = new Set([
      ...Object.keys(oracle as Record<string, unknown>),
      ...Object.keys(candidate as Record<string, unknown>),
    ]);
    for (const key of [...keys].sort()) {
      if (IGNORED_FIELDS.has(key)) continue;
      walk(
        (oracle as Record<string, unknown>)[key],
        (candidate as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        diffs,
        warns,
        textShas,
      );
    }
    return;
  }

  const field = leafField(path);
  const entry: DiffEntry = {
    path,
    oracle,
    candidate,
    severity: TOLERATED_FIELDS.has(field) ? "warning" : "regression",
    field,
  };
  if (entry.severity === "warning") {
    warns.push(entry);
  } else {
    diffs.push(entry);
  }
}

function leafField(path: string): string {
  // Strip array indices; return the trailing segment.
  const trimmed = path.replace(/\[\d+\]/g, "");
  const dot = trimmed.lastIndexOf(".");
  return dot === -1 ? trimmed : trimmed.slice(dot + 1);
}

export function diffFixture(
  candidate: unknown,
  oracle: unknown,
  kind: FixtureKind,
  options: {
    filing_dir: string;
    provenance?: FixtureProvenance;
  },
): DiffReport {
  const diffs: DiffEntry[] = [];
  const warns: DiffEntry[] = [];
  const textShas: DiffReport["text_sha_changes"] = [];

  const oracleC = canonicalJson(oracle);
  const candidateC = canonicalJson(candidate);
  walk(oracleC, candidateC, "", diffs, warns, textShas);

  const arr = (v: unknown) => (Array.isArray(v) ? v.length : 1);
  return {
    kind,
    provenance: options.provenance ?? "python-mirror",
    filing_dir: options.filing_dir,
    match: diffs.length === 0,
    regressions: diffs,
    warnings: warns,
    oracle_count: arr(oracle),
    candidate_count: arr(candidate),
    text_sha_changes: textShas,
  };
}

/**
 * Convenience wrapper that loads the oracle fixture from disk in one
 * call. Used by Vitest tests:
 *
 *   const report = await diffAgainstOracle(
 *     myExtractorOutput, "aapl", "000130817925000008", "executive_comp"
 *   );
 *   expect(report.match).toBe(true);
 */
export function diffAgainstOracle(
  candidate: unknown,
  companyId: string,
  filingId: string,
  kind: FixtureKind,
): DiffReport {
  const oracle = loadOracle(companyId, filingId, kind);

  // exec_comp fixtures are python-mirrors per Decisions D-002. All
  // other fixture kinds are also stored Python output, but they're
  // closer to "truth" because the Python writes them to SQLite once
  // and the TS will write them once too — same persistence shape.
  // We still tag them python-mirror until hand-curated truth is added
  // (see User-Action A-008).
  return diffFixture(candidate, oracle, kind, {
    filing_dir: `${companyId}/${filingId}`,
    provenance: "python-mirror",
  });
}
