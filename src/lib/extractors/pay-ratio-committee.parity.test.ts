/**
 * Parity test for the new CEO pay ratio + compensation committee
 * extractors. These don't have a Python oracle (they were added
 * after the freeze), so the test asserts known-good values per
 * fixture filing instead. Update when re-ingesting if the disclosure
 * format changes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractFactsFromCda } from "./facts";

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

function findFiling(companyId: string, accessionSuffix: string): string | null {
  const dir = join(FIXTURES, companyId);
  if (!existsSync(dir)) return null;
  const filings = readdirSync(dir).filter((f) => f !== "company.json");
  return filings.find((f) => f.endsWith(accessionSuffix)) ?? null;
}

describe("compensation_committee policy fact", () => {
  const cases: { company: string; filingSuffix: string; expected: string }[] = [
    { company: "aapl", filingSuffix: "26000008", expected: "People and Compensation Committee" },
    { company: "adbe", filingSuffix: "25000048", expected: "Executive Compensation Committee" },
    { company: "amzn", filingSuffix: "5910", expected: "Leadership Development and Compensation Committee" },
    { company: "googl", filingSuffix: "25000511", expected: "Compensation Committee" },
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

describe("CEO pay ratio metric fact", () => {
  const cases: { company: string; filingSuffix: string; ratio: string; median: string }[] = [
    // GOOGL 2025 proxy (covers 2024) — disclosed
    { company: "googl", filingSuffix: "25000511", ratio: "32 to 1", median: "$331,894" },
    { company: "googl", filingSuffix: "24000612", ratio: "28 to 1", median: "$315,531" },
    { company: "googl", filingSuffix: "23000736", ratio: "808:1", median: "$279,802" },
    // ADBE — 2026 filing covers fiscal 2025 (217:1 ratio).
    { company: "adbe", filingSuffix: "26000043", ratio: "217 to 1", median: "$235,989" },
    { company: "adbe", filingSuffix: "25000048", ratio: "250 to 1", median: "$209,583" },
    // META
    { company: "meta", filingSuffix: "0034", ratio: "64:1", median: "$379,050" },
    { company: "meta", filingSuffix: "0040", ratio: "65:1", median: "$417,400" },
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

  it("falls back gracefully when the disclosure isn't in the cd_and_a section", () => {
    // AAPL fixtures don't have the pay ratio in the cd_and_a section
    // (they file it as a separate post-CD&A section). The extractor
    // should not invent a value.
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
