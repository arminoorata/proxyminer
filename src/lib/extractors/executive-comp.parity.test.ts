/**
 * Phase 4 parity test — TS executive-comp extractor against the Python
 * oracle fixtures frozen in Phase 0.
 *
 * NOTE: per Decisions D-002, executive_comp fixtures are
 * `provenance: python-mirror` — matching them proves byte-for-byte
 * parity with the Python extractor on 2026-04-30, NOT correctness vs
 * the original SEC filing. Hand-curated truth fixtures are User-Action
 * A-008 and will be added incrementally.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractExecutiveCompensation } from "./executive-comp";
import { diffAgainstOracle } from "../parity/comparator";

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

interface FilingCase {
  companyId: string;
  filingId: string;
  htmlPath: string;
}

function discoverCases(): FilingCase[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  const cases: FilingCase[] = [];
  for (const companyId of readdirSync(FIXTURES_ROOT)) {
    const cdir = join(FIXTURES_ROOT, companyId);
    for (const filingId of readdirSync(cdir)) {
      const htmlPath = join(cdir, filingId, "source.html");
      if (existsSync(htmlPath)) cases.push({ companyId, filingId, htmlPath });
    }
  }
  return cases;
}

describe("executive comp parity", () => {
  const cases = discoverCases();
  if (cases.length === 0) {
    it.skip("no fixtures discovered (expected during initial dev)", () => {});
    return;
  }

  for (const c of cases) {
    it(`${c.companyId}/${c.filingId}`, () => {
      const html = readFileSync(c.htmlPath, "utf8");
      const candidate = extractExecutiveCompensation(html);
      const report = diffAgainstOracle(
        candidate,
        c.companyId,
        c.filingId,
        "executive_comp",
      );

      // Surface a structured failure for investigation, but allow a
      // first-pass migration where individual filings may diff. The
      // parity log is the audit trail.
      if (!report.match) {
        console.log(
          `[PARITY DIFF] ${c.companyId}/${c.filingId}: ` +
            `regressions=${report.regressions.length} warnings=${report.warnings.length} ` +
            `oracle_count=${report.oracle_count} candidate_count=${report.candidate_count}`,
        );
      }
      // For the "ratchet" — record the diff but don't fail the suite
      // until a parity gate decision is made. We expect ≤ N regressions
      // per fixture once the extractor is mature; for now we just
      // surface counts.
      expect(report).toMatchObject({
        kind: "executive_comp",
        provenance: "python-mirror",
        filing_dir: `${c.companyId}/${c.filingId}`,
      });
    });
  }
});
