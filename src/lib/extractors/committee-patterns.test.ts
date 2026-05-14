/**
 * Unit tests for compensation-committee name normalization.
 *
 * Each block is the exact phrasing observed in a real filing. The
 * normalizer must collapse common variants (case differences, all-caps
 * section headers, hybrid names) to a canonical Title-Case
 * "<Qualifier> Compensation Committee" form.
 */
import { describe, expect, it } from "vitest";

import { extractFactsFromCda } from "./facts";

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
