/**
 * Unit tests for the long-tail pay-ratio + median-employee patterns.
 *
 * These are textual smoke tests against synthetic minimal disclosures
 * — they don't require fixture HTML. Each block is the exact phrasing
 * observed in a real filing; the pattern set must capture both the
 * ratio value and the median dollar amount.
 */
import { describe, expect, it } from "vitest";

import { extractFactsFromCda } from "./facts";

describe("pay-ratio + median patterns (long-tail phrasing)", () => {
  const cases: { name: string; text: string; ratio: string; median: string | null }[] = [
    {
      name: "AYI — 'CEO Pay Ratio is estimated to be N to 1' + 'median associate'",
      text: `
        For fiscal 2025, the median of the annual total compensation of all of
        the Company's associates, other than Mr. Ashe, was $19,531, which
        equals the total fiscal 2025 compensation of our median associate
        identified as described above. Mr. Ashe's total annual compensation,
        as reported in the "Total Compensation" column of the Fiscal 2025
        Summary Compensation Table was $12,500,683. Based on this
        information, the CEO Pay Ratio is estimated to be 640 to 1.
      `,
      ratio: "640 to 1",
      median: "$19,531",
    },
    {
      name: "Generic 'estimated at N to 1'",
      text: `
        The total compensation of our median employee for fiscal 2024 was
        $52,400. The pay ratio for fiscal 2024 is estimated at 125 to 1.
      `,
      ratio: "125 to 1",
      median: "$52,400",
    },
    {
      name: "WMT-style 'median associate' with explicit ratio sentence",
      text: `
        For fiscal 2026, our median associate's total annual compensation was
        $30,500. Our CEO's total annual compensation was $29,200,000.
        Based on this information, the ratio of our CEO's total annual
        compensation to the median associate's total annual compensation was
        958 to 1.
      `,
      // Falls back to canonical "ratio of CEO to median ... was N to 1"
      // pattern because we listed "associate" as a valid term.
      ratio: "958 to 1",
      median: "$30,500",
    },
    {
      name: "Pay ratio in workers terminology (some payroll companies)",
      text: `
        Our median worker's total annual compensation for 2024 was $48,150.
        The ratio of our CEO's total annual compensation to that of our
        median worker is 320 to 1.
      `,
      ratio: "320 to 1",
      median: "$48,150",
    },
    {
      name: "USB — reversed anchor 'median to CEO ... is 1:178'",
      // U.S. Bancorp 2025 phrases the disclosure as "the ratio of the
      // annual total compensation of our median employee to the annual
      // total compensation of our CEO for 2025 is 1:178". Pre-fix the
      // ratio anchor only matched "ratio of CEO to median" direction.
      text: `
        The annual total compensation of our median employee for 2025
        was $95,307. The resulting ratio of the annual total
        compensation of our median employee to the annual total
        compensation of our CEO for 2025 is 1:178.
      `,
      ratio: "178 to 1",
      median: "$95,307",
    },
    {
      name: "ZTS — CEO referenced by name, 'ratio of <name>'s pay to our median employee's pay'",
      // Zoetis CD&A phrases the disclosure as "the ratio of Ms. Peck's
      // pay to our median employee's pay was 236 to 1". The CEO is
      // named explicitly rather than as "our CEO", so existing anchors
      // that require "(chief executive officer|ceo)" missed it.
      text: `
        For 2025, our median employee's annual total compensation
        (determined consistently with the SCT) was $80,592. Ms. Peck's
        total annual compensation for the year ended December 31, 2025,
        as disclosed in the Summary Compensation Table, was $19,046,509.
        Therefore, the ratio of Ms. Peck's pay to our median employee's
        pay was 236 to 1.
      `,
      ratio: "236 to 1",
      median: "$80,592",
    },
    {
      name: "HUBB — 'approximately N times that of [our] median employee'",
      // Hubbell phrases its disclosure narratively: "Mr. Bakker's
      // annual compensation was approximately 161 times that of
      // Hubbell's median employee." normalizePayRatio canonicalizes
      // "161 times" → "161 to 1".
      text: `
        Hubbell's median employee's annual total compensation for 2025
        was estimated as $64,210. As a result, we estimate that
        Mr. Bakker's annual compensation was approximately 161 times
        that of Hubbell's median employee.
      `,
      ratio: "161 to 1",
      median: "$64,210",
    },
    {
      name: "PNC — 'ratio of <Name>'s annual total compensation to ... median employee is N to 1'",
      // PNC phrases the ratio sentence around the CEO by name (no
      // "CEO" / "Chief Executive Officer" anchor): "the resulting
      // ratio of Mr. Demchak's annual total compensation to the
      // annual total compensation of our median employee is 226 to 1".
      text: `
        The annual total compensation of Mr. Demchak was $29,530,103.
        The annual total compensation of our median employee for 2025
        was $130,221. The resulting ratio of Mr. Demchak's annual total
        compensation to the annual total compensation of our median
        employee is 226 to 1.
      `,
      ratio: "226 to 1",
      median: "$130,221",
    },
    {
      name: "ROK — 'was N times the similarly calculated compensation of our median employee'",
      // Rockwell Automation phrases the disclosure as "Ms. Rumsey's
      // compensation (as reported in the Summary Compensation Table)
      // for 2025 was 312 times the similarly calculated compensation
      // of our median employee." Pre-fix the pattern required the word
      // "approximately" between "was" and "N times".
      text: `
        Our median employee's annual total compensation for 2025 was
        $47,123. Ms. Rumsey's compensation (as reported in the Summary
        Compensation Table) for 2025 was 312 times the similarly
        calculated compensation of our median employee.
      `,
      ratio: "312 to 1",
      median: "$47,123",
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ratio=${c.ratio}`, () => {
      const result = extractFactsFromCda(`test-${c.name}`, c.text);
      const ratio = result.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
      const median = result.metrics.find(
        (m) => m.metric_name_normalized === "median_employee_compensation",
      );
      expect(ratio?.observed_value).toBe(c.ratio);
      if (c.median !== null) expect(median?.observed_value).toBe(c.median);
    });
  }
});

describe("committee normalizer rejects section-header phrases", () => {
  it("rejects 'Compensation Risk Assessment The Committee' from a CD&A subsection header", async () => {
    const { extractFactsFromCda } = await import("./facts");
    const result = extractFactsFromCda(
      "adbe-test",
      `Compensation Risk Assessment

       The Committee has reviewed the Company's executive compensation program for
       potential risks. The Executive Compensation Committee believes our programs
       do not create undue risk.`,
    );
    const committee = result.policies.find((p) => p.policy_type === "compensation_committee");
    // Must NOT be the section-header artifact; should resolve via the
    // closed-form "Executive" qualifier instead.
    expect(committee?.normalized_value).toBe("Executive Compensation Committee");
  });
});

describe("section heading injection", () => {
  it("recognizes 'Compensation Committee Report' from a heading even when body uses an acronym", async () => {
    const { extractFactsFromSections } = await import("./facts");
    const result = extractFactsFromSections("wmt-test", [
      {
        section_type: "compensation_committee_report",
        heading: "Compensation Committee Report",
        text: "The CMDC has reviewed and discussed with our company's management the CD&A included in this proxy statement and recommended its inclusion. The CMDC submits this report.",
      },
    ]);
    const committee = result.policies.find((p) => p.policy_type === "compensation_committee");
    // We don't expect the full "and Management Development" name here —
    // the body uses CMDC throughout — but we do expect at least the
    // canonical "Compensation Committee" so the surface isn't empty.
    expect(committee?.normalized_value).toBe("Compensation Committee");
  });
});
