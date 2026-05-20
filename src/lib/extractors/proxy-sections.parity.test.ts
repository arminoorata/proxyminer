/**
 * Parity test for the post-CD&A section extractors (CEO pay ratio,
 * say-on-pay, compensation committee report). Asserts that the
 * extractor finds the right heading for every pilot-cohort filing.
 *
 * These extractors don't have a Python oracle — they were added when
 * we expanded section coverage beyond CD&A — so we maintain a
 * hand-curated expected-headings list per filing. Update when a
 * filing's heading format changes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractCdAndA } from "./cd-and-a";
import { extractProxySections, type ProxySectionType } from "./proxy-sections";

const FIXTURES = join(process.cwd(), ".fixtures", "by-filing");

function loadHtml(companyId: string, filingId: string): string | null {
  const path = join(FIXTURES, companyId, filingId, "source.html");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function findFiling(companyId: string, accessionSuffix: string): string | null {
  const dir = join(FIXTURES, companyId);
  if (!existsSync(dir)) return null;
  const filings = readdirSync(dir).filter((f) => f !== "company.json");
  return filings.find((f) => f.endsWith(accessionSuffix)) ?? null;
}

interface ExpectedSection {
  section_type: ProxySectionType;
  headingContains: string;
  minLength: number;
}

interface Case {
  company: string;
  filingSuffix: string;
  expect: ExpectedSection[];
}

// One case per (company, filing). Each case lists every section the
// extractor must surface for that filing.
const CASES: Case[] = [
  {
    company: "aapl",
    filingSuffix: "26000008",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO Pay Ratio", minLength: 1000 },
      { section_type: "say_on_pay", headingContains: "Advisory Vote", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation Committee Report", minLength: 200 },
    ],
  },
  {
    company: "msft",
    filingSuffix: "5150",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO Pay Ratio", minLength: 1000 },
      { section_type: "say_on_pay", headingContains: "Advisory Vote", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation Committee Report", minLength: 200 },
    ],
  },
  {
    company: "googl",
    filingSuffix: "25000511",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO Pay Ratio", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation Committee Report", minLength: 200 },
    ],
  },
  {
    company: "adbe",
    filingSuffix: "26000043",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO Pay Ratio", minLength: 1000 },
      { section_type: "say_on_pay", headingContains: "Advisory Vote", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Executive Compensation Committee", minLength: 200 },
    ],
  },
  {
    company: "meta",
    filingSuffix: "0040",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO PAY RATIO", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation, Nominating & Governance Committee", minLength: 500 },
    ],
  },
  {
    company: "amzn",
    filingSuffix: "5910",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "Pay Ratio", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation Committee Report", minLength: 200 },
    ],
  },
  {
    company: "nflx",
    filingSuffix: "0913",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "Pay Ratio Disclosure", minLength: 1000 },
      { section_type: "compensation_committee_report", headingContains: "Compensation Committee Report", minLength: 200 },
    ],
  },
  {
    company: "crm",
    filingSuffix: "5000009",
    expect: [
      { section_type: "ceo_pay_ratio", headingContains: "CEO Pay Ratio", minLength: 1000 },
    ],
  },
];

// Skip the whole parity suite if the source.html fixtures aren't on
// disk (e.g. fresh CI checkout — the raw HTML is gitignored because
// it's multi-MB per filing). `npm run fixtures:freeze` re-derives
// them locally for full parity coverage.
const FIXTURES_AVAILABLE = existsSync(FIXTURES) && readdirSync(FIXTURES).some((c) => {
  const cdir = join(FIXTURES, c);
  if (!existsSync(cdir)) return false;
  return readdirSync(cdir).some((f) => existsSync(join(cdir, f, "source.html")));
});

(FIXTURES_AVAILABLE ? describe : describe.skip)("proxy section extractors", () => {
  for (const c of CASES) {
    describe(`${c.company} ${c.filingSuffix}`, () => {
      for (const e of c.expect) {
        it(`extracts ${e.section_type} ("${e.headingContains}", ≥${e.minLength} chars)`, () => {
          const filingId = findFiling(c.company, c.filingSuffix);
          expect(filingId).not.toBeNull();
          const html = loadHtml(c.company, filingId!);
          expect(html).not.toBeNull();

          const sections = extractProxySections(html!);
          const found = sections.find((s) => s.section_type === e.section_type);
          expect(found).toBeDefined();
          expect(found?.section.heading.toLowerCase()).toContain(e.headingContains.toLowerCase());
          expect(found?.section.text.length).toBeGreaterThanOrEqual(e.minLength);
        });
      }
    });
  }

  it("preserves canonical CD&A extraction_method format (no -cda suffix regression)", () => {
    // Regression guard: the cd-and-a.ts refactor lifted heading/sibling
    // helpers into section-helpers.ts. The CD&A extractor must still
    // emit the legacy `exact-heading-and-sibling-blocks` extraction
    // method so that pg/fixture rows stay byte-identical to the python
    // oracle.
    const filingId = findFiling("aapl", "26000008");
    expect(filingId).not.toBeNull();
    const html = loadHtml("aapl", filingId!);
    expect(html).not.toBeNull();
    const cda = extractCdAndA(html!);
    expect(cda).not.toBeNull();
    expect(cda!.method).toMatch(/^(exact-heading|toc-anchor)-and-(sibling-blocks|document-flow)$/);
  });
});
