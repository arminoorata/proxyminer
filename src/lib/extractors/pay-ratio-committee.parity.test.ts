/**
 * Parity test for the CEO pay ratio + compensation committee fact
 * extractors and the section-level extraction that lets non-CD&A
 * disclosures (AAPL's Item 402(u) section, ADBE's "Report of the
 * Executive Compensation Committee", etc.) feed the same facts. No
 * Python oracle — these features were added after the freeze, so the
 * tests assert known-good values per fixture filing.
 *
 * Pay ratio values are canonicalized to "N to 1" form. Reversed
 * disclosures like AMZN's "1-to-43" come out as "43 to 1".
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractCdAndA } from "./cd-and-a";
import { extractFactsFromCda, extractFactsFromSections } from "./facts";
import { extractProxySections } from "./proxy-sections";

const FIXTURES = join(process.cwd(), ".fixtures", "by-filing");

interface Section {
  section_type: string;
  text: string;
}

function loadCda(companyId: string, filingId: string): string | null {
  const path = join(FIXTURES, companyId, filingId, "sections.json");
  if (!existsSync(path)) return null;
  const sections = JSON.parse(readFileSync(path, "utf8")) as Section[];
  return sections.find((s) => s.section_type === "cd_and_a")?.text ?? null;
}

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

function runAllSections(companyId: string, filingId: string) {
  const html = loadHtml(companyId, filingId);
  if (!html) throw new Error(`missing source.html for ${companyId}/${filingId}`);
  const cda = extractCdAndA(html);
  const proxySections = extractProxySections(html);
  const inputs = [
    ...(cda ? [{ section_type: "cd_and_a", text: cda.text }] : []),
    ...proxySections.map((p) => ({ section_type: p.section_type, text: p.section.text })),
  ];
  return extractFactsFromSections(`${companyId}-test`, inputs);
}

describe("compensation_committee policy fact (CD&A only)", () => {
  const cases: { company: string; filingSuffix: string; expected: string }[] = [
    { company: "aapl", filingSuffix: "26000008", expected: "People and Compensation Committee" },
    { company: "adbe", filingSuffix: "25000048", expected: "Executive Compensation Committee" },
    { company: "amzn", filingSuffix: "5910", expected: "Leadership Development and Compensation Committee" },
    { company: "googl", filingSuffix: "25000511", expected: "Leadership Development, Inclusion and Compensation Committee" },
    { company: "msft", filingSuffix: "5150", expected: "Compensation Committee" },
    { company: "nflx", filingSuffix: "0913", expected: "Compensation Committee" },
  ];

  for (const c of cases) {
    it(`extracts "${c.expected}" for ${c.company}`, () => {
      const filingId = findFiling(c.company, c.filingSuffix);
      expect(filingId).not.toBeNull();
      const cda = loadCda(c.company, filingId!);
      expect(cda).not.toBeNull();
      const result = extractFactsFromCda(`${c.company}-test`, cda!);
      const committee = result.policies.find((p) => p.policy_type === "compensation_committee");
      expect(committee).toBeDefined();
      expect(committee?.normalized_value).toBe(c.expected);
    });
  }
});

describe("CEO pay ratio metric fact (CD&A only, canonical N-to-1 form)", () => {
  const cases: { company: string; filingSuffix: string; ratio: string; median: string }[] = [
    { company: "googl", filingSuffix: "25000511", ratio: "32 to 1", median: "$331,894" },
    { company: "googl", filingSuffix: "24000612", ratio: "28 to 1", median: "$315,531" },
    { company: "googl", filingSuffix: "23000736", ratio: "808 to 1", median: "$279,802" },
    { company: "adbe", filingSuffix: "26000043", ratio: "217 to 1", median: "$235,989" },
    { company: "adbe", filingSuffix: "25000048", ratio: "250 to 1", median: "$209,583" },
    { company: "meta", filingSuffix: "0034", ratio: "64 to 1", median: "$379,050" },
    { company: "meta", filingSuffix: "0040", ratio: "65 to 1", median: "$417,400" },
  ];

  for (const c of cases) {
    it(`extracts ratio ${c.ratio} + median ${c.median} for ${c.company} (${c.filingSuffix})`, () => {
      const filingId = findFiling(c.company, c.filingSuffix);
      expect(filingId).not.toBeNull();
      const cda = loadCda(c.company, filingId!);
      expect(cda).not.toBeNull();
      const result = extractFactsFromCda(`${c.company}-test`, cda!);
      const ratio = result.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
      const median = result.metrics.find(
        (m) => m.metric_name_normalized === "median_employee_compensation",
      );
      expect(ratio?.observed_value).toBe(c.ratio);
      expect(median?.observed_value).toBe(c.median);
    });
  }

  it("returns nothing when CD&A doesn't carry the pay-ratio disclosure (AAPL)", () => {
    // AAPL files Item 402(u) in its own section after CD&A — so the
    // CD&A-only fact extractor should not invent a value.
    const filingId = findFiling("aapl", "26000008");
    expect(filingId).not.toBeNull();
    const cda = loadCda("aapl", filingId!);
    expect(cda).not.toBeNull();
    const result = extractFactsFromCda("aapl-test", cda!);
    const ratio = result.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
    const median = result.metrics.find(
      (m) => m.metric_name_normalized === "median_employee_compensation",
    );
    expect(ratio).toBeUndefined();
    expect(median).toBeUndefined();
  });
});

describe("section-level extraction (Item 402(u) + Item 407(e)(5) outside CD&A)", () => {
  // These filings have facts that don't appear in CD&A but do appear in
  // dedicated proxy sections. The section-aware extractor must surface
  // them with `extraction_method` recording which section they came from.
  const cases: {
    company: string;
    filingSuffix: string;
    ratio: string;
    median: string;
    committee: string;
    ratioSourceContains: string;
  }[] = [
    { company: "aapl", filingSuffix: "26000008", ratio: "533 to 1", median: "$139,483", committee: "People and Compensation Committee", ratioSourceContains: "ceo_pay_ratio" },
    { company: "msft", filingSuffix: "5150", ratio: "480 to 1", median: "$200,972", committee: "Compensation Committee", ratioSourceContains: "ceo_pay_ratio" },
    { company: "nflx", filingSuffix: "0913", ratio: "248 to 1", median: "$200,761", committee: "Compensation Committee", ratioSourceContains: "ceo_pay_ratio" },
    { company: "amzn", filingSuffix: "5910", ratio: "37 to 1", median: "$36,274", committee: "Leadership Development and Compensation Committee", ratioSourceContains: "ceo_pay_ratio" },
  ];

  for (const c of cases) {
    it(`extracts pay ratio + median + committee from section-level for ${c.company} (${c.filingSuffix})`, () => {
      const filingId = findFiling(c.company, c.filingSuffix);
      expect(filingId).not.toBeNull();
      const result = runAllSections(c.company, filingId!);

      const ratio = result.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
      expect(ratio?.observed_value).toBe(c.ratio);
      expect(ratio?.extraction_method).toContain(c.ratioSourceContains);

      const median = result.metrics.find(
        (m) => m.metric_name_normalized === "median_employee_compensation",
      );
      expect(median?.observed_value).toBe(c.median);

      const committee = result.policies.find((p) => p.policy_type === "compensation_committee");
      expect(committee?.normalized_value).toBe(c.committee);
    });
  }

  it("normalizes META's hybrid committee name from section text", () => {
    const filingId = findFiling("meta", "0034");
    expect(filingId).not.toBeNull();
    const result = runAllSections("meta", filingId!);
    const committee = result.policies.find((p) => p.policy_type === "compensation_committee");
    expect(committee?.normalized_value).toBe("Compensation, Nominating & Governance Committee");
  });

  it("normalizes AMZN reversed pay ratio (1-to-43 → 43 to 1)", () => {
    const filingId = findFiling("amzn", "5910");
    expect(filingId).not.toBeNull();
    const result = runAllSections("amzn", filingId!);
    const ratio = result.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
    expect(ratio?.observed_value).toBe("37 to 1");
  });
});
