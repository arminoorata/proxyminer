/**
 * Synthetic SCT HTML fixtures.
 *
 * Each fixture reproduces a wrap-collapse / format quirk observed in a
 * real filing that the v1 SCT extractor missed. They're hand-built to
 * be small (and committed to the repo, unlike the multi-MB raw
 * `.fixtures/by-filing/**\/source.html` corpus which is gitignored)
 * so coverage tests can assert known-good output deterministically.
 *
 * When extending: keep each fixture to a single SCT-style table plus
 * the heading immediately preceding it. Don't include unrelated proxy
 * content — that's what the full-fixture parity tests are for.
 */

export interface SyntheticFixture {
  /** Identifier (matches the original filer whose quirk it captures). */
  label: string;
  /** Full HTML document with just the SCT region. */
  html: string;
  /** Expected CEO total for the latest year. */
  expectedCeoTotal: string;
  /** Expected CEO executive name (after the name-cleanup pass). */
  expectedCeoName: string;
  /** Substring expected in `principal_position`. */
  expectedPositionContains: string;
  /** Latest disclosed fiscal year in the table. */
  expectedYear: number;
}

const HTML_HEAD = `<!doctype html><html><body>`;
const HTML_FOOT = `</body></html>`;

/**
 * NVDA-style: heading "Summary Compensation Table for Fiscal …",
 * camel-cased "FiscalYear" header (no space), separator columns
 * between data columns, single name + rowspan-style multi-year rows.
 */
const NVDA_LIKE = `
${HTML_HEAD}
<p>These values differ from those reported in the Summary Compensation Table and the Pay Versus Performance Table.</p>
<table><tr><td>placeholder</td></tr></table>
<div><b>Summary Compensation Table for Fiscal 2025, 2024, and 2023</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th><th></th>
    <th>FiscalYear</th><th></th>
    <th>Salary($)</th><th></th>
    <th>StockAwards ($)</th><th></th>
    <th>Non-Equity Incentive Plan Comp</th><th></th>
    <th>All Other Comp ($)</th><th></th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Jen-Hsun Huang</td><td></td>
    <td>2025</td><td></td>
    <td>1,486,199</td><td></td>
    <td></td><td></td>
    <td>38,811,306</td><td></td>
    <td>9,568,746</td><td></td>
    <td>49,866,251</td>
  </tr>
  <tr>
    <td>President and CEO</td><td></td>
    <td>2024</td><td></td>
    <td>996,514</td><td></td>
    <td></td><td></td>
    <td>26,676,415</td><td></td>
    <td>6,000,000</td><td></td>
    <td>33,672,929</td>
  </tr>
  <tr>
    <td></td><td></td>
    <td>2023</td><td></td>
    <td>996,832</td><td></td>
    <td></td><td></td>
    <td>19,666,382</td><td></td>
    <td>4,000,000</td><td></td>
    <td>24,663,214</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * ADBE-style: heading present, position rendered as
 * "CHAIR OF THE BOARD AND CEO" (acronym only, no "Chief Executive
 * Officer" full phrase) so the v1 CEO detector couldn't match.
 */
const ADBE_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table for Fiscal Years 2025, 2024 and 2023</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Shantanu Narayen<br>CHAIR OF THE BOARD AND CEO</td>
    <td>2025</td>
    <td>1,500,000</td>
    <td>45,500,000</td>
    <td>3,200,000</td>
    <td>973,935</td>
    <td>51,173,935</td>
  </tr>
  <tr>
    <td>Shantanu Narayen<br>CHAIR OF THE BOARD AND CEO</td>
    <td>2024</td>
    <td>1,500,000</td>
    <td>46,500,000</td>
    <td>3,400,000</td>
    <td>990,182</td>
    <td>52,390,182</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * CRM-style: single cell contains "Marc BenioffChair of the Board
 * and CEO" — bold wrap collapsed the space between name and title.
 * `splitNameAndPosition` must insert a space before "Chair".
 */
const CRM_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Fiscal Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Marc BenioffChair of the Board and CEO</td>
    <td>2025</td>
    <td>1,550,000</td>
    <td>40,000,000</td>
    <td>13,400,000</td>
    <td>124,656</td>
    <td>55,074,656</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * KEY-style: regional-bank SCT with "Chairman and CEO" acronym, no
 * wrap-collapse but the v1 detector still missed because of the
 * acronym-only CEO regex.
 */
const KEY_LIKE = `
${HTML_HEAD}
<h3>Summary Compensation Table</h3>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>Change in Pension Value</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Christopher M. Gorman</td>
    <td>2025</td>
    <td>1,150,000</td>
    <td>0</td>
    <td>7,200,000</td>
    <td>2,800,000</td>
    <td>123,500</td>
    <td>248,525</td>
    <td>11,522,025</td>
  </tr>
  <tr>
    <td>Chairman and CEO</td>
    <td>2024</td>
    <td>1,100,000</td>
    <td>0</td>
    <td>14,000,000</td>
    <td>3,200,000</td>
    <td>180,000</td>
    <td>158,612</td>
    <td>18,638,612</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * AYI-style: name + title wrap-collapsed within a single cell
 * ("Neil M. AsheChairman, President and CEO"). After cleanup the
 * displayed name must be "Neil M. Ashe", with the full title preserved
 * in `principal_position`.
 */
const AYI_LIKE = `
${HTML_HEAD}
<p style="font-weight:bold">Summary Compensation Table</p>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>Change in Pension Value and Nonqualified Deferred Compensation Earnings ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Neil M. AsheChairman, President and CEO</td>
    <td>2025</td>
    <td>1,000,000</td>
    <td></td>
    <td>8,576,928</td>
    <td></td>
    <td>1,512,000</td>
    <td>1,399,155</td>
    <td>12,600</td>
    <td>12,500,683</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * WMT-style: bold-styled header wrap caused "Name andPrincipal" and
 * "FiscalYearendedJan. 31" collapses. Position is "President and CEO"
 * (acronym only).
 */
const WMT_LIKE = `
${HTML_HEAD}
<div style="font-weight:bold">Summary Compensation</div>
<table>
  <tr>
    <th>Name andPrincipal Position(a)</th>
    <th></th>
    <th>FiscalYearendedJan. 31(b)</th>
    <th></th>
    <th>Salary($)(c)</th>
    <th></th>
    <th>Bonus($) (d)</th>
    <th></th>
    <th>Stock Awards($)(e)</th>
    <th></th>
    <th>Non-EquityIncentive PlanCompensation($)(f)</th>
    <th></th>
    <th>Change in Pension Value(g)</th>
    <th></th>
    <th>All OtherCompensation($)(i)</th>
    <th></th>
    <th>Total($)</th>
  </tr>
  <tr>
    <td>Doug McMillon</td><td></td>
    <td>2026</td><td></td>
    <td>1,500,000</td><td></td>
    <td>—</td><td></td>
    <td>21,051,605</td><td></td>
    <td>4,032,000</td><td></td>
    <td>2,215,278</td><td></td>
    <td>442,047</td><td></td>
    <td>29,240,930</td>
  </tr>
  <tr>
    <td>President and CEO</td><td></td>
    <td>2025</td><td></td>
    <td>1,511,539</td><td></td>
    <td>—</td><td></td>
    <td>20,375,675</td><td></td>
    <td>4,356,000</td><td></td>
    <td>783,745</td><td></td>
    <td>381,895</td><td></td>
    <td>27,408,854</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * NFLX-style: co-CEO row with "TED SARANDOSco-Chief Executive Officer"
 * wrap-collapse. Tests assert the display name doesn't keep a
 * dangling "co-" suffix once trailing-title cleanup runs.
 */
const NFLX_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>TED SARANDOSco-Chief Executive Officer and President</td>
    <td>2024</td>
    <td>3,000,000</td>
    <td>50,000,000</td>
    <td>8,500,000</td>
    <td>422,397</td>
    <td>61,922,397</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * INTC-style: SCT lists a CEO transitioning out where the same
 * executive name appears across multiple rows for the same fiscal
 * year — once with values keyed to the name row, and once on a
 * position-fragment row that ALSO carries values (Intel discloses a
 * "former CEO" sub-line with its own totals). Pre-fix this produced
 * two rows with identical (executive_name, year) and tripped the
 * `exec_comp_filing_exec_year_idx` UNIQUE constraint on insert. The
 * extractor must collapse to one row per (name, year), preferring the
 * row with the larger total.
 */
const INTC_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Patrick P. Gelsinger</td>
    <td>2024</td>
    <td>1,250,000</td>
    <td>10,000,000</td>
    <td>2,500,000</td>
    <td>1,200,000</td>
    <td>14,950,000</td>
  </tr>
  <tr>
    <td>Former Chief Executive Officer</td>
    <td>2024</td>
    <td>0</td>
    <td>0</td>
    <td>0</td>
    <td>800,000</td>
    <td>800,000</td>
  </tr>
  <tr>
    <td>Patrick P. Gelsinger</td>
    <td>2023</td>
    <td>1,150,000</td>
    <td>13,000,000</td>
    <td>2,200,000</td>
    <td>1,000,000</td>
    <td>17,350,000</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * HBAN-style: SCT renders the executive name on row 1, "Chairman,
 * President," on row 2, and "and CEO" on row 3 (three-line cell
 * stacked across rowspan'd data rows). Pre-fix the row carrying
 * "and CEO" — paired with its own year column — was promoted to a
 * new executive name, splintering Steinour's three-year history into
 * two execs and dropping "and CEO" from his canonical position. The
 * fix adds `^(and|or|the)\s+(Chair|Chief|...)` to TITLE_FRAGMENT
 * so a continuation row reads as a position fragment, not a name.
 */
const HBAN_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Stephen D. Steinour</td>
    <td>2025</td>
    <td>1,250,000</td>
    <td>8,300,000</td>
    <td>2,375,000</td>
    <td>199,358</td>
    <td>12,124,358</td>
  </tr>
  <tr>
    <td>Chairman, President,</td>
    <td>2024</td>
    <td>1,200,000</td>
    <td>7,000,000</td>
    <td>1,650,000</td>
    <td>175,663</td>
    <td>10,025,663</td>
  </tr>
  <tr>
    <td>and CEO</td>
    <td>2023</td>
    <td>1,150,000</td>
    <td>6,500,000</td>
    <td>2,400,000</td>
    <td>129,479</td>
    <td>10,179,479</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * DIS-style: name cell renders "Robert A. Iger2Chief Executive
 * Officer; Former Executive Chairman" — a footnote marker digit ("2")
 * sits between the surname and the title-word "Chief", which prevents
 * the NAME_TITLE_BOUNDARY regex from inserting the missing space and
 * leaves "Iger2Chief" in the name column. Fix: allow optional digits
 * between the lowercase letter and the title keyword
 * (`([a-z])\d*(${TITLE_KEYWORDS})`); the digit is dropped by the
 * `$1 $2` replacement.
 */
const DIS_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Fiscal Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Robert A. Iger2Chief Executive Officer; Former Executive Chairman</td>
    <td>2025</td>
    <td>1,000,000</td>
    <td>35,000,000</td>
    <td>9,420,000</td>
    <td>422,574</td>
    <td>45,842,574</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * HD-style: a "name banner" row containing only the executive's name
 * and principal position in column 0 (the rest of the cells in that
 * row are empty), followed by three year-only data rows whose cells
 * are interleaved with empty spacer cells. The header has 9 columns;
 * each data row has ~17 cells (9 values + 8 spacers).
 *
 * Pre-Phase-H the extractor lost these tables entirely because:
 *   1. The banner row has no year, so it was either skipped or
 *      absorbed into the header aggregation (polluting headers).
 *   2. The data rows have more cells than the header, so
 *      `cellValue(row, columnMap.total)` pointed at a spacer cell
 *      and `values.total` came back empty, dropping the row.
 *
 * The fix:
 *   - `looksLikeBannerRow` recognises the pattern and seeds
 *     currentName + position from it (both for the banner before
 *     dataStart and for banners encountered mid-loop).
 *   - `compressSpacerRow` collapses alternating-empty data rows
 *     down to header width when the non-empty cell count matches
 *     header column count exactly.
 */
const HD_LIKE = `
${HTML_HEAD}
<div><b>SUMMARY COMPENSATION TABLE</b></div>
<table>
  <tr>
    <th>Name, Principal Position and Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>Change in Pension Value ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Edward P. Decker Chair, President and Chief Executive Officer</td>
    <td></td><td></td><td></td>
  </tr>
  <tr>
    <td>2025</td><td></td>
    <td>1,400,000</td><td></td>
    <td>—</td><td></td>
    <td>9,612,251</td><td></td>
    <td>2,369,917</td><td></td>
    <td>2,657,631</td><td></td>
    <td>—</td><td></td>
    <td>151,328</td><td></td>
    <td>16,191,127</td>
  </tr>
  <tr>
    <td>2024</td><td></td>
    <td>1,426,923</td><td></td>
    <td>—</td><td></td>
    <td>9,043,035</td><td></td>
    <td>2,199,952</td><td></td>
    <td>2,743,532</td><td></td>
    <td>—</td><td></td>
    <td>161,237</td><td></td>
    <td>15,574,678</td>
  </tr>
  <tr>
    <td>Richard V. McPhail Executive Vice President and Chief Financial Officer</td>
    <td></td><td></td><td></td>
  </tr>
  <tr>
    <td>2025</td><td></td>
    <td>971,923</td><td></td>
    <td>—</td><td></td>
    <td>3,414,074</td><td></td>
    <td>839,919</td><td></td>
    <td>928,747</td><td></td>
    <td>—</td><td></td>
    <td>69,633</td><td></td>
    <td>6,224,296</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * PNC-style: the SCT has BOTH a "Total Stock Awards ($)" column in
 * the middle (an intra-table subtotal across annual + other stock)
 * AND the canonical "Total ($)" column on the right. Pre-Phase-H2
 * the extractor matched both against `/\btotal\b/`, tied on score,
 * and picked the leftmost — which was the empty spacer cell adjacent
 * to "Total Stock Awards", dropping every row.
 *
 * The fix narrows the canonical-Total regex to exclude headers like
 * "Total Stock Awards" / "Total Compensation" via a negative
 * lookahead, so the right-hand "Total ($)" wins cleanly.
 */
const PNC_LIKE = `
${HTML_HEAD}
<div><b>Summary compensation table</b></div>
<table>
  <tr>
    <th>Name & Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Annual Stock Award ($)</th>
    <th>Other Stock Award ($)</th>
    <th>Total Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>William S. Demchak Chairman and CEO</td>
    <td>2025</td>
    <td>1,300,000</td>
    <td>—</td>
    <td>17,500,184</td>
    <td>—</td>
    <td>17,500,184</td>
    <td>9,200,000</td>
    <td>170,221</td>
    <td>29,503,081</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * Real-PNC multi-row header: row 0 has a "Stock Awards (group)"
 * header spanning multiple data columns AND a rowspan that pulls the
 * "Change in Pension Value" group header into a third header row.
 * Row 1 carries the leaf labels (Name, Year, Salary, ...) but with
 * colspan=2 on each label. Data rows have rowspan=3 name cells (so
 * the name only appears in the first year-row; the 2024 and 2023
 * year-rows have an empty name column), and the values sit at the
 * second cell of each colspan-2 pair.
 *
 * The standard column-index extractor can't align this — after dedup,
 * the leaf header positions don't line up with data positions. The
 * positional fallback extractor handles it by finding name (first
 * person-name cell), year (first year-pattern cell), and total (last
 * numeric cell) per row, with rowspan-style name carryover for the
 * year-only continuation rows.
 */
const PNC_MULTIROW_LIKE = `
${HTML_HEAD}
<div><b>Summary compensation table</b></div>
<table>
  <tr>
    <th rowspan="2">Name &amp; Principal Position</th>
    <th rowspan="2" colspan="2">Year</th>
    <th rowspan="2" colspan="2">Salary ($)</th>
    <th rowspan="2" colspan="2">Bonus ($)</th>
    <th colspan="6">Stock Awards (group)</th>
    <th rowspan="2" colspan="2">Non-Equity Incentive ($)</th>
    <th rowspan="2" colspan="2">All Other ($)</th>
    <th rowspan="2" colspan="2">Total ($)</th>
  </tr>
  <tr>
    <th colspan="2">Annual Stock</th>
    <th colspan="2">Other Stock</th>
    <th colspan="2">Total Stock Awards</th>
  </tr>
  <tr>
    <td rowspan="3">William S. Demchak Chairman and CEO</td>
    <td></td><td>2025</td>
    <td></td><td>1,300,000</td>
    <td></td><td>—</td>
    <td></td><td>17,500,184</td>
    <td></td><td>—</td>
    <td></td><td>17,500,184</td>
    <td></td><td>9,200,000</td>
    <td></td><td>170,221</td>
    <td></td><td>29,503,081</td>
  </tr>
  <tr>
    <td></td><td>2024</td>
    <td></td><td>1,294,615</td>
    <td></td><td>—</td>
    <td></td><td>13,090,041</td>
    <td></td><td>—</td>
    <td></td><td>13,090,041</td>
    <td></td><td>6,200,000</td>
    <td></td><td>950,809</td>
    <td></td><td>22,352,785</td>
  </tr>
  <tr>
    <td></td><td>2023</td>
    <td></td><td>1,200,000</td>
    <td></td><td>—</td>
    <td></td><td>12,750,115</td>
    <td></td><td>—</td>
    <td></td><td>12,750,115</td>
    <td></td><td>4,410,000</td>
    <td></td><td>792,588</td>
    <td></td><td>19,950,306</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * ORCL-style: incoming CEO has position "Executive Vice Chair and
 * Former Chief Executive Officer". The predicate still matches her
 * as a CEO row for fiscal 2025 (she WAS CEO during the year), but
 * the display surface should annotate the transition.
 */
const ORCL_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Fiscal Year</th>
    <th>Salary ($)</th>
    <th>Stock Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td>Safra A. Catz<br>Executive Vice Chair and Former Chief Executive Officer</td>
    <td>2025</td>
    <td>950,025</td>
    <td>0</td>
    <td>0</td>
    <td>163,392</td>
    <td>1,113,417</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * ACN-style: TWO-row banner — a name-only banner row (uniform-cell
 * "Julie Sweet") followed by a position-only banner row (uniform-cell
 * "Chair and chief executive officer"), and only THEN the year-rows.
 * Pre-fix, the banner detector required the name + position in a
 * single banner cell, so the name-only banner was missed entirely
 * and currentName stayed null → zero rows emitted.
 */
const ACN_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr><td colspan="8">Julie Sweet</td></tr>
  <tr><td colspan="8">Chair and chief executive officer</td></tr>
  <tr>
    <td>2025</td><td>$1,550,000</td><td>—</td><td>$22,876,232</td>
    <td>—</td><td>$4,500,000</td><td>$715,671</td><td>$29,641,903</td>
  </tr>
  <tr>
    <td>2024</td><td>$1,550,000</td><td>—</td><td>$21,048,615</td>
    <td>—</td><td>$2,000,000</td><td>$316,531</td><td>$24,915,146</td>
  </tr>
  <tr><td colspan="8">Angie Park</td></tr>
  <tr><td colspan="8">Chief financial officer</td></tr>
  <tr>
    <td>2025</td><td>$838,155</td><td>—</td><td>$3,068,985</td>
    <td>—</td><td>$909,398</td><td>$4,457</td><td>$4,820,995</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * UBER-style: name-only banner row followed by data rows where the
 * year-1 row's name column carries the POSITION text ("Chief Executive
 * Officer & Director"), and year-2/year-3 rows have an empty name
 * column. Pre-fix, the banner-detector rejected the name-only row
 * (no position included), so currentName never seeded.
 */
const UBER_LIKE = `
${HTML_HEAD}
<div><b>Summary Compensation Table</b></div>
<table>
  <tr>
    <th>Name</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr><td colspan="9">Dara Khosrowshahi</td></tr>
  <tr>
    <td>Chief Executive Officer &amp; Director</td>
    <td>2025</td><td>1,083,333</td><td>—</td><td>23,746,098</td>
    <td>7,373,189</td><td>2,838,660</td><td>554,547</td><td>35,595,826</td>
  </tr>
  <tr>
    <td></td><td>2024</td><td>1,000,000</td><td>—</td><td>26,654,091</td>
    <td>7,902,378</td><td>2,878,200</td><td>973,960</td><td>39,408,629</td>
  </tr>
  <tr><td colspan="9">Prashanth Mahendra-Rajah</td></tr>
  <tr>
    <td>Chief Financial Officer</td>
    <td>2025</td><td>800,000</td><td>—</td><td>9,420,781</td>
    <td>3,125,227</td><td>1,032,240</td><td>204,257</td><td>14,582,504</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * PG-style: fiscal-year-range labels ("2024-25", "2023-24") in the
 * Year column. P&G's fiscal year ends in June so they label each row
 * by the two calendar years it spans. The end-year (2025, 2024, 2023)
 * is the canonical SCT year. Pre-fix, YEAR_PATTERN /^(?:19|20)\d{2}$/
 * rejected "2024-25" and dataStartIndex never identified a data row.
 */
const PG_LIKE = `
${HTML_HEAD}
<div><b>SUMMARY COMPENSATION TABLE</b></div>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td rowspan="3">Jon R. Moeller Chairman of the Board, President, and CEO</td>
    <td>2024-25</td><td>1,637,500</td><td>—</td><td>11,560,128</td>
    <td>5,600,006</td><td>2,808,750</td><td>303,432</td><td>21,909,816</td>
  </tr>
  <tr>
    <td>2023-24</td><td>1,600,000</td><td>4,086,400</td><td>11,301,824</td>
    <td>5,600,006</td><td>0</td><td>375,651</td><td>22,963,881</td>
  </tr>
  <tr>
    <td>2022-23</td><td>1,600,000</td><td>4,712,000</td><td>11,372,562</td>
    <td>3,625,001</td><td>0</td><td>406,062</td><td>21,715,625</td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

/**
 * AMGN-style: three years' values stacked vertically inside ONE
 * table cell using <br> tags. Each data row holds all years for
 * one executive: the Year cell has "2025<br>2024<br>2023" and each
 * value cell has the same shape. Pre-fix, cheerio's .text() flattened
 * the <br>s into "202520242023" / "1,925,4091,869,2421,786,977" and
 * the row was unparseable. Post-fix, explodeBrStackedRows() splits
 * the row into one matrix row per year.
 */
const AMGN_LIKE = `
${HTML_HEAD}
<p><b>Summary Compensation Table</b></p>
<table>
  <tr>
    <th>Name and Principal Position</th>
    <th>Year</th>
    <th>Salary ($)</th>
    <th>Bonus ($)</th>
    <th>Stock Awards ($)</th>
    <th>Option Awards ($)</th>
    <th>Non-Equity Incentive Plan Compensation ($)</th>
    <th>All Other Compensation ($)</th>
    <th>Total ($)</th>
  </tr>
  <tr>
    <td><p>Robert A. Bradway Chief Executive Officer and President</p></td>
    <td><p>2025<br>2024<br>2023</p></td>
    <td><p>1,925,409<br>1,869,242<br>1,786,977</p></td>
    <td><p>—<br>—<br>—</p></td>
    <td><p>12,599,589<br>12,599,930<br>11,138,503</p></td>
    <td><p>5,399,996<br>5,399,991<br>4,773,714</p></td>
    <td><p>3,907,000<br>3,845,000<br>4,264,000</p></td>
    <td><p>861,126<br>714,332<br>680,456</p></td>
    <td><p>24,693,120<br>24,428,495<br>22,643,650</p></td>
  </tr>
  <tr>
    <td><p>Peter H. Griffith Executive Vice President and Chief Financial Officer</p></td>
    <td><p>2025<br>2024<br>2023</p></td>
    <td><p>1,223,994<br>1,133,633<br>1,083,762</p></td>
    <td><p>—<br>—<br>—</p></td>
    <td><p>3,709,745<br>3,359,613<br>3,149,928</p></td>
    <td><p>1,589,962<br>1,439,984<br>1,349,985</p></td>
    <td><p>1,652,000<br>1,555,000<br>1,724,000</p></td>
    <td><p>435,186<br>318,581<br>261,623</p></td>
    <td><p>8,610,887<br>7,806,811<br>7,569,298</p></td>
  </tr>
</table>
${HTML_FOOT}
`.trim();

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
  {
    label: "acn-like",
    html: ACN_LIKE,
    expectedCeoTotal: "$29,641,903",
    expectedCeoName: "Julie Sweet",
    expectedPositionContains: "chief executive officer",
    expectedYear: 2025,
  },
  {
    label: "uber-like",
    html: UBER_LIKE,
    expectedCeoTotal: "35,595,826",
    expectedCeoName: "Dara Khosrowshahi",
    expectedPositionContains: "Chief Executive Officer",
    expectedYear: 2025,
  },
  {
    label: "pg-like",
    html: PG_LIKE,
    expectedCeoTotal: "21,909,816",
    expectedCeoName: "Jon R. Moeller",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
  {
    label: "amgn-like",
    html: AMGN_LIKE,
    expectedCeoTotal: "24,693,120",
    expectedCeoName: "Robert A. Bradway",
    expectedPositionContains: "Chief Executive Officer",
    expectedYear: 2025,
  },
  {
    label: "nvda-like",
    html: NVDA_LIKE,
    expectedCeoTotal: "49,866,251",
    expectedCeoName: "Jen-Hsun Huang",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
  {
    label: "adbe-like",
    html: ADBE_LIKE,
    expectedCeoTotal: "51,173,935",
    expectedCeoName: "Shantanu Narayen",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
  {
    label: "crm-like",
    html: CRM_LIKE,
    expectedCeoTotal: "55,074,656",
    expectedCeoName: "Marc Benioff",
    expectedPositionContains: "Chair of the Board and CEO",
    expectedYear: 2025,
  },
  {
    label: "key-like",
    html: KEY_LIKE,
    expectedCeoTotal: "11,522,025",
    expectedCeoName: "Christopher M. Gorman",
    expectedPositionContains: "Chairman and CEO",
    expectedYear: 2025,
  },
  {
    label: "ayi-like",
    html: AYI_LIKE,
    expectedCeoTotal: "12,500,683",
    expectedCeoName: "Neil M. Ashe",
    expectedPositionContains: "President and CEO",
    expectedYear: 2025,
  },
  {
    label: "wmt-like",
    html: WMT_LIKE,
    expectedCeoTotal: "29,240,930",
    expectedCeoName: "Doug McMillon",
    expectedPositionContains: "President and CEO",
    expectedYear: 2026,
  },
  {
    label: "hban-like",
    html: HBAN_LIKE,
    expectedCeoTotal: "12,124,358",
    expectedCeoName: "Stephen D. Steinour",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
  {
    label: "dis-like",
    html: DIS_LIKE,
    expectedCeoTotal: "45,842,574",
    expectedCeoName: "Robert A. Iger",
    expectedPositionContains: "Chief Executive Officer",
    expectedYear: 2025,
  },
  {
    label: "hd-like",
    html: HD_LIKE,
    expectedCeoTotal: "16,191,127",
    expectedCeoName: "Edward P. Decker",
    expectedPositionContains: "Chief Executive Officer",
    expectedYear: 2025,
  },
  {
    label: "pnc-like",
    html: PNC_LIKE,
    expectedCeoTotal: "29,503,081",
    expectedCeoName: "William S. Demchak",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
  {
    label: "pnc-multirow-header",
    html: PNC_MULTIROW_LIKE,
    expectedCeoTotal: "29,503,081",
    expectedCeoName: "William S. Demchak",
    expectedPositionContains: "CEO",
    expectedYear: 2025,
  },
];

export const NFLX_LIKE_FIXTURE = NFLX_LIKE;
export const ORCL_LIKE_FIXTURE = ORCL_LIKE;
export const INTC_LIKE_FIXTURE = INTC_LIKE;
