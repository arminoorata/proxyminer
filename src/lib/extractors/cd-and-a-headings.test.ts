/**
 * Synthetic heading-variant tests for the CD&A extractor.
 *
 * Phase 17 audit found four cohort tickers (IBM, HUBB, PSA, AMZE) where
 * the CD&A extractor missed the section because the heading carried a
 * qualifier prefix (e.g. "Executive ", "2024 ") or a parenthetical
 * abbreviation suffix ("(CD&A)"). The previous regex was a strict
 * fullMatch on /^compensation discussion (and|&) analysis$/.
 *
 * These tests pin each expanded variant against a minimal HTML doc so
 * a regression in the heading regex fails loudly with a focused
 * synthetic, not a fixture parity diff that depends on source.html.
 */
import { describe, expect, it } from "vitest";

import { extractCdAndA } from "./cd-and-a";

function buildDoc(heading: string): string {
  return `
    <html><body>
      <h1>Proxy Statement</h1>
      <h2>${heading}</h2>
      <p>The following Compensation Discussion and Analysis describes our
      executive compensation philosophy and the decisions made by the
      Compensation Committee for fiscal 2024. ${"This paragraph adds the body content the section extractor requires to consider the section non-empty and beyond the heading-only branch. ".repeat(20)}</p>
      <h2>Summary Compensation Table</h2>
      <p>The table below summarizes compensation paid to our NEOs.</p>
    </body></html>
  `;
}

describe("CD&A heading variants", () => {
  const cases: { name: string; heading: string }[] = [
    {
      name: "default — Compensation Discussion and Analysis",
      heading: "Compensation Discussion and Analysis",
    },
    {
      name: "default — ampersand variant",
      heading: "Compensation Discussion & Analysis",
    },
    {
      name: "IBM — Executive prefix",
      heading: "Executive Compensation Discussion and Analysis",
    },
    {
      name: "Named-Executive-Officer prefix",
      heading: "Named Executive Officer Compensation Discussion and Analysis",
    },
    {
      name: "Named-Executive-Officers plural prefix",
      heading: "Named Executive Officers Compensation Discussion and Analysis",
    },
    {
      name: "year prefix — 2024 Compensation Discussion and Analysis",
      heading: "2024 Compensation Discussion and Analysis",
    },
    {
      name: "fiscal-year prefix — Fiscal Year 2024 ...",
      heading: "Fiscal Year 2024 Compensation Discussion and Analysis",
    },
    {
      name: "PSA/HUBB — (CD&A) abbreviation suffix",
      heading: "Compensation Discussion and Analysis (CD&A)",
    },
    {
      name: "HUBB — (\"CD&A\") quoted abbreviation suffix",
      heading: 'Compensation Discussion and Analysis ("CD&A")',
    },
    {
      name: "HUBB — (the \"CD&A\") quoted abbreviation suffix",
      heading: 'Compensation Discussion and Analysis (the "CD&A")',
    },
  ];

  for (const { name, heading } of cases) {
    it(`captures ${name}`, () => {
      const section = extractCdAndA(buildDoc(heading));
      expect(section).not.toBeNull();
      expect(section!.heading.toLowerCase()).toContain(
        "compensation discussion",
      );
      // Body collection should succeed past the heading-only branch.
      expect(section!.text.length).toBeGreaterThan(200);
    });
  }

  it("does NOT match unrelated headings", () => {
    const bad = buildDoc("Compensation Practices and Risk Assessment");
    const section = extractCdAndA(bad);
    expect(section).toBeNull();
  });
});
