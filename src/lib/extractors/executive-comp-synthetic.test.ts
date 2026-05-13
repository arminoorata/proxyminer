/**
 * Hard regression gate for the SCT extractor, using synthetic HTML
 * fixtures committed to the repo (the real .fixtures/by-filing/**\/source.html
 * corpus is gitignored, so the parity-style tests skip silently on
 * machines without the freeze). These tests never skip: each filer-
 * format quirk that broke the v1 extractor gets a small inline
 * fixture and a hard assertion on the resulting CEO total.
 */
import { describe, expect, it } from "vitest";

import { extractExecutiveCompensation } from "./executive-comp";
import { isCeoPosition } from "../exec/ceo";
import { cleanExecutiveDisplayName } from "../exec/display";
import {
  NFLX_LIKE_FIXTURE,
  ORCL_LIKE_FIXTURE,
  SYNTHETIC_FIXTURES,
} from "./__fixtures__/sct-synthetic";

describe("SCT extractor — synthetic edge-format fixtures", () => {
  for (const fixture of SYNTHETIC_FIXTURES) {
    it(`extracts CEO ${fixture.expectedCeoTotal} from ${fixture.label}`, () => {
      const rows = extractExecutiveCompensation(fixture.html);
      expect(rows.length).toBeGreaterThan(0);
      const latestYear = Math.max(...rows.map((r) => r.year));
      expect(latestYear).toBe(fixture.expectedYear);
      const ceoRow = rows.find(
        (r) =>
          r.year === fixture.expectedYear &&
          isCeoPosition(r.principal_position),
      );
      expect(ceoRow, `no CEO row for ${fixture.label}`).toBeDefined();
      expect(ceoRow?.total).toBe(fixture.expectedCeoTotal);
      expect(ceoRow?.executive_name).toContain(fixture.expectedCeoName);
      expect(ceoRow?.principal_position ?? "").toContain(
        fixture.expectedPositionContains,
      );
    });
  }
});

describe("SCT extractor — cosmetic display cleanups", () => {
  it("NFLX co-CEO display name: cleanExecutiveDisplayName strips dangling 'co-'", () => {
    // The raw extractor output may leave a dangling 'co-' on the name
    // when the cell wrapped between SARANDOS and "co-Chief...". The
    // centralized display helper strips trailing fragments at every
    // UI surface (company page, compare, exec table, PDF, diff).
    const rows = extractExecutiveCompensation(NFLX_LIKE_FIXTURE);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.year).toBe(2024);
    const displayName = cleanExecutiveDisplayName(row.executive_name);
    expect(displayName).toBe("TED SARANDOS");
    expect(displayName.toLowerCase()).not.toMatch(/co-?$/);
  });

  it("ORCL transitioned CEO: position still matches isCeoPosition + transition flag detectable", () => {
    const rows = extractExecutiveCompensation(ORCL_LIKE_FIXTURE);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => isCeoPosition(r.principal_position));
    expect(row, "transitioned CEO row should still match isCeoPosition").toBeDefined();
    // The position carries the "Former" marker the UI can use to
    // render a "transitioned" annotation next to the value.
    expect(row?.principal_position ?? "").toMatch(/\bFormer\b/i);
    // Annotation logic — kept inline here as the canonical test of
    // what the UI should detect; the company page can mirror it.
    const isTransitioned = /\b(Former|Outgoing|Retired)\b.*\b(Chief\s+Executive|CEO)\b/i.test(
      row?.principal_position ?? "",
    );
    expect(isTransitioned).toBe(true);
  });
});
