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

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
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
];

export const NFLX_LIKE_FIXTURE = NFLX_LIKE;
export const ORCL_LIKE_FIXTURE = ORCL_LIKE;
