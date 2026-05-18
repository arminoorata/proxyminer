/**
 * HTML-table peer-group extraction fixtures. Many filers (HUBB, MA,
 * WMT, etc.) put the actual peer-company list in a 3-column or
 * 4-column HTML table immediately after a "Compensation Peer Group"
 * heading rather than in CD&A paragraph text. The CD&A-only text
 * extractor misses these entirely. The HTML-table extractor reads
 * each cell of the next-following table, keeps those that carry a
 * corporate suffix (Inc., Corp., etc.), and only emits a group when
 * at least 7 recognized companies are found.
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroupsFromHtmlTables } from "./peer-groups";

const HEAD = `<!doctype html><html><body>`;
const FOOT = `</body></html>`;

describe("peer-extractor — HTML table fallback", () => {
  it("HUBB-style: 3-column table after 'Compensation Peer Group' heading", () => {
    // Hubbell renders its peer group as a 3-column table with the
    // company names in alternating value/spacer cells.
    const html = `${HEAD}
      <h3>Compensation Peer Group</h3>
      <p>The Peer Group used to determine pay levels for 2025 was constructed as follows:</p>
      <table>
        <tr>
          <td>Acuity Brands, Inc.</td><td></td>
          <td>EnerSys</td><td></td>
          <td>Ingersoll Rand Inc.</td><td></td>
        </tr>
        <tr>
          <td>AMETEK, Inc.</td><td></td>
          <td>Fortive Corporation</td><td></td>
          <td>ITT Inc.</td><td></td>
        </tr>
        <tr>
          <td>Carlisle Companies Incorporated</td><td></td>
          <td>Fortune Brands Innovations, Inc.</td><td></td>
          <td>Lennox International Inc.</td><td></td>
        </tr>
        <tr>
          <td>Dover Corporation</td><td></td>
          <td>Illinois Tool Works Inc.</td><td></td>
          <td>Lincoln Electric Holdings, Inc.</td><td></td>
        </tr>
      </table>
    ${FOOT}`;
    const groups = extractPeerGroupsFromHtmlTables("hubb-test", html);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0].members.length).toBeGreaterThanOrEqual(10);
    expect(groups[0].peer_group_type).toBe("compensation");
    const names = groups[0].members.map((m) => m.company_name_raw);
    expect(names).toContain("Acuity Brands, Inc.");
    expect(names).toContain("Illinois Tool Works Inc.");
  });

  it("rejects table with no corporate-suffix cells (false-positive guard)", () => {
    const html = `${HEAD}
      <h3>Peer Group</h3>
      <table>
        <tr><td>Q1</td><td>Q2</td><td>Q3</td></tr>
        <tr><td>10%</td><td>15%</td><td>20%</td></tr>
        <tr><td>$1M</td><td>$2M</td><td>$3M</td></tr>
      </table>
    ${FOOT}`;
    const groups = extractPeerGroupsFromHtmlTables("test", html);
    expect(groups).toEqual([]);
  });

  it("rejects when fewer than 7 corporate-suffix cells found", () => {
    const html = `${HEAD}
      <h3>Peer Group</h3>
      <table>
        <tr><td>Acme Inc.</td><td>Beta Corp.</td><td>Gamma Co.</td></tr>
      </table>
    ${FOOT}`;
    const groups = extractPeerGroupsFromHtmlTables("test", html);
    expect(groups).toEqual([]);
  });

  it("ignores tables not preceded by a peer-group heading", () => {
    const html = `${HEAD}
      <h3>Summary Compensation Table</h3>
      <table>
        <tr>
          <td>Acuity Brands, Inc.</td><td>EnerSys</td><td>Ingersoll Rand Inc.</td>
        </tr>
        <tr>
          <td>AMETEK, Inc.</td><td>Fortive Corporation</td><td>ITT Inc.</td>
        </tr>
        <tr>
          <td>Dover Corporation</td><td>Illinois Tool Works Inc.</td><td>Lincoln Electric Holdings, Inc.</td>
        </tr>
      </table>
    ${FOOT}`;
    const groups = extractPeerGroupsFromHtmlTables("test", html);
    expect(groups).toEqual([]);
  });
});
