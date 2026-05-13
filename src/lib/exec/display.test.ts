import { describe, expect, it } from "vitest";

import { cleanExecutiveDisplayName } from "./display";

describe("cleanExecutiveDisplayName", () => {
  // Wrap-collapse artifacts that the SCT extractor leaks into the
  // executive_name field. The UI should strip these for display.
  const STRIP_CASES: Array<[string, string]> = [
    ["TED SARANDOSco-", "TED SARANDOS"],
    ["Sundar PichaiChief", "Sundar Pichai"],
    ["Neil M. AsheChairman", "Neil M. Ashe"],
    ["Doug McMillonPresident", "Doug McMillon"],
    ["Marc BenioffChair", "Marc Benioff"],
    ["Christopher M. GormanChair", "Christopher M. Gorman"],
    ["Karen J. HolcomSVP", "Karen J. Holcom"],
    ["Mary Q. ExampleEVP", "Mary Q. Example"],
    ["Pat ExampleSenior Vice President", "Pat Example"],
    ["Pat Example Officer", "Pat Example"],
    // Trailing whitespace + title both stripped.
    ["TED SARANDOS co- ", "TED SARANDOS"],
  ];
  for (const [input, expected] of STRIP_CASES) {
    it(`strips trailing title fragment: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(cleanExecutiveDisplayName(input)).toBe(expected);
    });
  }

  // Legitimate names that end in title-like substrings without the
  // wrap-collapse signal. Must NOT be mangled.
  const PRESERVE_CASES: string[] = [
    "Maria Bianco",          // ends in "co" — NOT a wrap, no hyphen
    "Marco Polo",            // both tokens end in "o"
    "Cisco Ramon",
    "Banco Santander",
    "Franco Smith",
    "John Marco",
    "Jane Smith Co",         // bare "Co" without hyphen — actual surname suffix
    "Sundar Pichai",         // already clean
    "TED SARANDOS",          // already clean
    "Ravi Inc",              // not a title we strip
    "Pat Coa",               // "Co" inside word, not at end
  ];
  for (const input of PRESERVE_CASES) {
    it(`preserves legitimate name: ${JSON.stringify(input)}`, () => {
      expect(cleanExecutiveDisplayName(input)).toBe(input);
    });
  }

  it("handles null + empty + undefined", () => {
    expect(cleanExecutiveDisplayName(null)).toBe("");
    expect(cleanExecutiveDisplayName(undefined)).toBe("");
    expect(cleanExecutiveDisplayName("")).toBe("");
    expect(cleanExecutiveDisplayName("   ")).toBe("");
  });

  it("strips only the trailing fragment, leaves middle/start alone", () => {
    // "Chief" at start should be kept (it's part of the person's
    // historic surname? unlikely but more importantly the rule is
    // about TRAILING fragments only).
    expect(cleanExecutiveDisplayName("Chief Joseph")).toBe("Chief Joseph");
    // Middle word "Chief" is part of the name string; we only strip
    // when it's at the end.
    expect(cleanExecutiveDisplayName("Pat Chief Smith")).toBe("Pat Chief Smith");
  });
});
