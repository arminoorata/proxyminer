/**
 * Unit tests for compensation-committee name normalization.
 *
 * Each block is the exact phrasing observed in a real filing. The
 * normalizer must collapse common variants (case differences, all-caps
 * section headers, hybrid names) to a canonical Title-Case
 * "<Qualifier> Compensation Committee" form.
 */
import { describe, expect, it } from "vitest";

import { extractFactsFromCda, extractFactsFromSections } from "./facts";

describe("compensation_committee normalization (long-tail phrasing)", () => {
  const cases: { name: string; text: string; expected: string }[] = [
    {
      name: "HD — all-caps committee-report section header",
      // Home Depot's Leadership Development and Compensation Committee
      // is referenced in body text only via the LDC Committee abbrev,
      // but the section heading is the full name in ALL CAPS. The
      // normalizer must still resolve this to the Title-Case canonical.
      text: `
        Table of Contents
        LEADERSHIP DEVELOPMENT AND COMPENSATION COMMITTEE REPORT
        Each member of the LDC Committee is independent under SEC
        and NYSE listing rules. The LDC Committee has reviewed and
        discussed the Compensation Discussion and Analysis with
        management.
      `,
      expected: "Leadership Development and Compensation Committee",
    },
    {
      name: "Mixed-case body text — sanity check (no regression)",
      text: `
        The People and Compensation Committee reviewed the CEO's pay
        for fiscal 2025 and approved the final program design.
      `,
      expected: "People and Compensation Committee",
    },
    {
      name: "Plain Compensation Committee — fallback",
      text: `
        The Compensation Committee oversees executive pay decisions.
      `,
      expected: "Compensation Committee",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = extractFactsFromCda(`test-${c.name}`, c.text);
      const committee = result.policies.find(
        (p) => p.policy_type === "compensation_committee",
      );
      expect(committee?.normalized_value).toBe(c.expected);
    });
  }
});

describe("compensation_committee dedupe across sections", () => {
  it("dedicated committee_report section overrides a null CD&A match", () => {
    // HD's CD&A body mentions "LDC Committee" abbreviation only and a
    // few bare "compensation committee" lowercase phrases. Pre-fix, the
    // CD&A scan emitted a compensation_committee policy with
    // normalized_value=null AND blocked the dedicated
    // compensation_committee_report section from running (since
    // seenPolicyTypes tracked by policy_type alone). The fix tracks
    // "satisfied" (non-null) separately so the dedicated section can
    // re-run and replace the null row with the resolved value.
    const cdaText = `
      Compensation Discussion and Analysis
      Mitigating Compensation Risk. The LDC Committee performs a
      broad-based review and risk assessment of our compensation
      policies and practices for fiscal 2026.
    `;
    const committeeHeading = "LEADERSHIP DEVELOPMENT AND COMPENSATION COMMITTEE REPORT";
    const committeeText = `
      Table of Contents
      LEADERSHIP DEVELOPMENT AND COMPENSATION COMMITTEE REPORT
      Each member of the LDC Committee is independent under SEC rules,
      NYSE listing standards and the Director Independence Standards
      adopted by the Board.
    `;
    const result = extractFactsFromSections("hd-test", [
      { section_type: "cd_and_a", text: cdaText, heading: "Compensation Discussion and Analysis" },
      { section_type: "compensation_committee_report", text: committeeText, heading: committeeHeading },
    ]);
    const committee = result.policies.filter((p) => p.policy_type === "compensation_committee");
    // Exactly one resolved row — not a null one from CD&A plus a
    // non-null one from the dedicated section.
    expect(committee.length).toBe(1);
    expect(committee[0].normalized_value).toBe("Leadership Development and Compensation Committee");
    expect(committee[0].extraction_method).toMatch(/compensation_committee_report/);
  });

  it("dedicated section is skipped when CD&A already produced a resolved committee name", () => {
    const cdaText = `
      The People and Compensation Committee reviewed and approved
      the fiscal 2025 program design.
    `;
    const committeeText = `
      Each member of the Compensation Committee is independent under
      SEC rules.
    `;
    const result = extractFactsFromSections("test", [
      { section_type: "cd_and_a", text: cdaText, heading: null },
      { section_type: "compensation_committee_report", text: committeeText, heading: null },
    ]);
    const committee = result.policies.filter((p) => p.policy_type === "compensation_committee");
    expect(committee.length).toBe(1);
    // CD&A's "People and" qualifier wins — the dedicated section's
    // generic "Compensation Committee" doesn't downgrade it.
    expect(committee[0].normalized_value).toBe("People and Compensation Committee");
  });
});
