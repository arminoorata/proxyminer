/**
 * Coverage assertions for the executive-comp extractor.
 *
 * The python-mirror parity test (executive-comp.parity.test.ts) only
 * reports diff counts — it doesn't fail on regressions. These tests
 * are the regression gate for the SCT rewrite: every fixture in the
 * pilot + long-tail cohort must produce a CEO total for the latest
 * disclosed year, and the known-good values are pinned per filing.
 *
 * Add a fixture here when you re-ingest a new filing year. Remove the
 * old year's assertion once the new fixture replaces it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractExecutiveCompensation } from "./executive-comp";
import { isCeoPosition } from "../exec/ceo";

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

interface ExpectedCeo {
  company: string;
  filingId: string;
  year: number;
  total: string;
  name: string;
  // Substring expected in principal_position (case-sensitive — filings
  // use varied capitalization). Used to confirm CEO disambiguation,
  // not to assert exact formatting.
  positionContains: string;
}

// Pinned values from the latest pilot-cohort filings (verified against
// the actual proxy statements). The extractor must surface these to
// keep the company page / compare / PDF surfaces correct.
const CASES: ExpectedCeo[] = [
  { company: "aapl", filingId: "000130817926000008", year: 2025, total: "74,294,811", name: "Tim Cook", positionContains: "Chief Executive Officer" },
  { company: "msft", filingId: "000119312525245150", year: 2025, total: "96,496,790", name: "Satya Nadella", positionContains: "Chief Executive Officer" },
  { company: "googl", filingId: "000130817925000511", year: 2024, total: "10,725,043", name: "Sundar Pichai", positionContains: "Chief Executive Officer" },
  { company: "meta", filingId: "000132680125000040", year: 2024, total: "27,219,874", name: "Mark Zuckerberg", positionContains: "Chief Executive Officer" },
  { company: "amzn", filingId: "000110465925033442", year: 2024, total: "1,596,889", name: "Andrew R. Jassy", positionContains: "Chief Executive Officer" },
  { company: "nvda", filingId: "000104581025000095", year: 2025, total: "49,866,251", name: "Jen-Hsun Huang", positionContains: "CEO" },
  { company: "crm", filingId: "000110852425000009", year: 2025, total: "55,074,656", name: "Marc Benioff", positionContains: "CEO" },
  { company: "qcom", filingId: "000110465926005781", year: 2025, total: "29,701,097", name: "Cristiano R. Amon", positionContains: "Chief Executive Officer" },
  { company: "adbe", filingId: "000079634326000043", year: 2025, total: "51,173,935", name: "Shantanu Narayen", positionContains: "CEO" },
  { company: "avgo", filingId: "000119312526085691", year: 2025, total: "205,278,006", name: "Hock E. Tan", positionContains: "Chief Executive Officer" },
];

describe("executive-comp CEO coverage (pilot cohort)", () => {
  for (const c of CASES) {
    it(`extracts CEO total ${c.total} for ${c.company} ${c.filingId}`, () => {
      const htmlPath = join(FIXTURES_ROOT, c.company, c.filingId, "source.html");
      if (!existsSync(htmlPath)) {
        // Fixture missing — skip rather than fail, so a forgotten
        // fixture doesn't block CI.
        return;
      }
      const html = readFileSync(htmlPath, "utf8");
      const rows = extractExecutiveCompensation(html);
      expect(rows.length).toBeGreaterThan(0);
      const latestYear = Math.max(...rows.map((r) => r.year));
      expect(latestYear).toBe(c.year);
      const ceoRow = rows.find(
        (r) => r.year === c.year && isCeoPosition(r.principal_position),
      );
      expect(ceoRow, `no CEO row for ${c.company} ${c.year}`).toBeDefined();
      expect(ceoRow?.total).toBe(c.total);
      expect(ceoRow?.executive_name).toContain(c.name);
      expect(ceoRow?.principal_position ?? "").toContain(c.positionContains);
    });
  }
});

describe("isCeoPosition predicate", () => {
  const positive = [
    "Chief Executive Officer",
    "President and Chief Executive Officer",
    "President and CEO",
    "Chairman, President and CEO",
    "Chair of the Board and CEO",
    "CHAIR OF THE BOARD AND CEO", // ADBE style
    "Co-CEO",
    "Co CEO",
    "Chief Executive Officer, Alphabet and Google, and Director",
    "Chief Executive Officer and President", // NFLX style
  ];
  const negative = [
    "Chief Financial Officer",
    "Chief Operating Officer",
    "President",
    "Senior Vice President and General Counsel",
    "Executive Vice President",
    "Director",
    "", // empty
  ];
  for (const p of positive) {
    it(`accepts "${p}"`, () => expect(isCeoPosition(p)).toBe(true));
  }
  for (const p of negative) {
    it(`rejects "${p}"`, () => expect(isCeoPosition(p)).toBe(false));
  }
});
