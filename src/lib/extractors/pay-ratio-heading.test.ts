/**
 * Pay-ratio section heading shape fixtures. Each case is a synthetic
 * HTML doc containing only the heading + a few paragraphs of
 * Item 402(u) language. The section extractor must surface the
 * section (heading captured, text non-empty) for every shape.
 */
import { describe, expect, it } from "vitest";

import { extractProxySections } from "./proxy-sections";

interface HeadingFixture {
  label: string;
  html: string;
}

const HEAD = `<!doctype html><html><body>`;
const FOOT = `</body></html>`;
const PAYLOAD = `
  <p>We are providing this disclosure pursuant to a rule adopted by
  the SEC implementing a mandate of the Dodd-Frank Act. The rule
  requires disclosure of the annual total compensation of the median
  employee, excluding the CEO, the annual total compensation of the
  CEO, and the ratio of these amounts. The resulting ratio of our
  CEO's total compensation to that of our median employee is 226 to 1.</p>
  <p>Methodology details follow below. The annual total compensation
  of our median employee for 2025 was $130,221.</p>
`;

const FIXTURES: HeadingFixture[] = [
  {
    label: "rok-style — 'PAY RATIO DISCLOSURE' all caps",
    html: `${HEAD}<h2>PAY RATIO DISCLOSURE</h2>${PAYLOAD}${FOOT}`,
  },
  {
    label: "hban-style — 'Executive Compensation Tables: Pay Ratio Disclosure'",
    html: `${HEAD}<h2>Executive Compensation Tables: Pay Ratio Disclosure</h2>${PAYLOAD}${FOOT}`,
  },
  {
    label: "hban-style — 'Pay Ratio Discl osure' (broken-word PDF artifact)",
    html: `${HEAD}<h2>Pay Ratio Discl osure</h2>${PAYLOAD}${FOOT}`,
  },
  {
    label: "canonical — 'CEO Pay Ratio' bare",
    html: `${HEAD}<h2>CEO Pay Ratio</h2>${PAYLOAD}${FOOT}`,
  },
];

describe("pay-ratio section heading recognition", () => {
  for (const f of FIXTURES) {
    it(f.label, () => {
      const sections = extractProxySections(f.html);
      const found = sections.find((s) => s.section_type === "ceo_pay_ratio");
      expect(found, `no ceo_pay_ratio section for ${f.label}`).toBeDefined();
      expect(found?.section.text.length).toBeGreaterThan(50);
    });
  }
});
