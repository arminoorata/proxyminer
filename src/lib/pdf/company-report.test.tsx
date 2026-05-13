/**
 * Tests the data-prep helpers that the PDF report renders from.
 *
 * The PDF's React tree consumes `ceoRow(filing)` (for the headline
 * tile + pay-mix breakdown + citations) and `prepareSctRows(filing,
 * year)` (for the Summary Compensation Table on Page 2). Both must
 * apply `cleanExecutiveDisplayName` so wrap-collapse fragments like
 * "TED SARANDOSco-" and "Sundar PichaiChief" don't leak into the PDF
 * — but legitimate surnames ending in "co" must pass through.
 */
import { describe, expect, it } from "vitest";

import { ceoRow, prepareSctRows } from "./company-report";
import type { ExecutiveCompRow, FilingDetail } from "@/lib/types";

function makeRow(
  name: string,
  position: string,
  year: number,
  total: string,
): ExecutiveCompRow {
  return {
    executive_name: name,
    principal_position: position,
    year,
    salary: "1,000,000",
    bonus: null,
    stock_awards: "10,000,000",
    option_awards: null,
    non_equity_incentive_plan_compensation: "2,000,000",
    all_other_compensation: "100,000",
    total,
    source_excerpt: "",
  };
}

function makeFiling(rows: ExecutiveCompRow[]): FilingDetail {
  return {
    id: "test", company_id: "test", accession_number: "x",
    form_type: "DEF 14A", filing_date: new Date(), filing_year: 2025,
    primary_document_url: null, primary_document_name: null,
    source_index_url: null, sections: [], policies: [], peer_groups: [],
    metrics: [], executive_compensation: rows,
  } as unknown as FilingDetail;
}

describe("ceoRow — PDF headline data helper", () => {
  it("strips dangling 'co-' from NFLX co-CEO name", () => {
    const filing = makeFiling([
      makeRow("TED SARANDOSco-", "Chief Executive Officer and President", 2024, "61,922,397"),
    ]);
    const ceo = ceoRow(filing);
    expect(ceo?.executive_name).toBe("TED SARANDOS");
  });

  it("strips trailing 'Chairman' fragment from AYI-style cell", () => {
    // AYI's cell renders "Neil M. Ashe<br>Chairman, President and CEO"
    // and cheerio collapses the <br> on text() so the name carries a
    // trailing "Chairman" artifact. Position still has the full title
    // so isCeoPosition matches via the CEO acronym.
    const filing = makeFiling([
      makeRow("Neil M. AsheChairman", "Chairman, President and CEO", 2025, "12,500,683"),
    ]);
    const ceo = ceoRow(filing);
    expect(ceo?.executive_name).toBe("Neil M. Ashe");
  });

  it("leaves a legitimate name ending in 'co' alone", () => {
    const filing = makeFiling([
      makeRow("Maria Bianco", "Chief Executive Officer", 2025, "5,000,000"),
    ]);
    const ceo = ceoRow(filing);
    expect(ceo?.executive_name).toBe("Maria Bianco");
  });
});

describe("prepareSctRows — PDF SCT-table helper", () => {
  it("applies cleanup to every row, not just the CEO", () => {
    const filing = makeFiling([
      makeRow("Doug McMillonPresident", "President and CEO", 2026, "29,240,930"),
      makeRow("Brett BiggsChief", "CFO", 2026, "10,000,000"),
      makeRow("Maria Bianco", "Chief Operating Officer", 2026, "8,000,000"),
    ]);
    const rows = prepareSctRows(filing, 2026);
    expect(rows.map((r) => r.executive_name)).toEqual([
      "Doug McMillon",
      "Brett Biggs",
      "Maria Bianco",
    ]);
  });

  it("returns [] when latestYear is null (no SCT rows)", () => {
    expect(prepareSctRows(makeFiling([]), null)).toEqual([]);
  });

  it("filters to the requested year + caps at 6 rows", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow(`Exec ${i}`, "CFO", 2025, `${1_000_000 - i * 10_000}`),
    );
    const result = prepareSctRows(makeFiling(rows), 2025);
    expect(result).toHaveLength(6);
    // Sort is by total desc; Exec 0 has the highest total.
    expect(result[0].executive_name).toBe("Exec 0");
  });
});
