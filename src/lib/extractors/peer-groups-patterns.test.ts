/**
 * Synthetic fixtures for the new peer-extractor patterns added in
 * Phase F1. Each block reproduces a real filing shape that the
 * pre-F1 extractor missed; the new patterns must produce ≥1 group
 * with the expected member count and peer_group_type.
 *
 * Why synthetic and not full HTML: the peer-group list itself is the
 * load-bearing input, not the surrounding layout. Keeping each
 * fixture inline makes the failure mode obvious when a future change
 * regresses one of these shapes.
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroups } from "./peer-groups";

interface PeerFixture {
  label: string;
  cdaText: string;
  expectedMembersAtLeast: number;
  expectedType: string | null;
}

const FIXTURES: PeerFixture[] = [
  {
    label: "meta-style: heading 'Peer Group' glued to first member",
    // Meta's CD&A renders the heading + member table as a single
    // text run with no whitespace between "Group" and "Alphabet".
    // Pre-fix `\bpeer group\b` failed because `p`→`A` has no word
    // boundary. The new pattern's `(?=\b|[A-Z])` lookahead fixes it.
    cdaText: `
In the second quarter of 2024, using this criteria as a baseline, the
compensation committee approved the following companies for inclusion
in our Peer Group for 2025:

Peer GroupAlphabet (GOOG, GOOGL)NVIDIA (NVDA)Amazon.com (AMZN)Oracle (ORCL)Apple (AAPL)salesforce.com (CRM)AT&T (T)The Walt Disney Company (DIS)Cisco Systems (CSCO)Uber Technologies (UBER)Comcast (CMCSA)Verizon Communications (VZ)Microsoft (MSFT)
`.trim(),
    expectedMembersAtLeast: 10,
    expectedType: null,
  },
  {
    label: "hd-style: 'Retail Peer Group' modifier with member list",
    cdaText: `
The Compensation Committee considered data provided by Pay Governance
from two peer groups. The retail peer group was unchanged from Fiscal
2024.

Retail Peer GroupAmazon.com Ross Stores, Inc. AutoZone, Inc. Target Corporation Costco Wholesale Corporation The Kroger Co. Lowe's Companies, Inc. The TJX Companies, Inc.
`.trim(),
    expectedMembersAtLeast: 6,
    expectedType: "retail",
  },
  {
    label: "dhr-style: 'Company's peer group ... consisted of the companies set forth below'",
    cdaText: `
Executive Compensation Peer Group

The Company's peer group (for purposes of all 2025 executive
compensation decisions and the 2026 executive compensation decisions
described above) consisted of the companies set forth below:

Abbott Laboratories (ABT) Boston Scientific Corporation (BSX) Johnson
& Johnson (JNJ) AbbVie Inc. (ABBV) Bristol-Myers Squibb Company (BMY)
Medtronic Inc. (MDT) Agilent Technologies (A) Eli Lilly and Company
(LLY) Merck & Co. (MRK) Amgen Inc. (AMGN) Gilead Sciences (GILD)
Stryker Corporation (SYK)
`.trim(),
    expectedMembersAtLeast: 8,
    expectedType: "compensation",
  },
  {
    label: "cost-style: 'for fiscal YYYY ... for the following peer companies'",
    cdaText: `
Peer Companies

For fiscal 2025, the Committee primarily considered executive
compensation data obtained from proxy statements for the following
peer companies: Walmart Inc., The Home Depot, Inc., Lowe's Companies,
Inc., The TJX Companies, Inc., Target Corporation, The Kroger Company,
Best Buy Inc., BJ's Wholesale Club Holdings, Inc.
`.trim(),
    expectedMembersAtLeast: 6,
    expectedType: null,
  },
  {
    label: "fitb-style: 'the following N companies were identified ... as our Compensation Peer Group for YYYY'",
    cdaText: `
The Compensation Peer Group consists of companies with which the
Committee believes the Company competes for talent and for shareholder
investment. The following 12 companies were identified by the
Committee as our Compensation Peer Group for 2025:

Fifth Third Bancorp, KeyCorp, Huntington Bancshares Incorporated,
M&T Bank Corporation, Regions Financial Corporation, Citizens
Financial Group, Inc., U.S. Bancorp, PNC Financial Services Group,
Inc., Truist Financial Corporation, BOK Financial Corporation,
Northern Trust Corporation, Comerica Incorporated.
`.trim(),
    expectedMembersAtLeast: 6,
    expectedType: "compensation",
  },
];

describe("peer-extractor — Phase F1 pattern fixtures", () => {
  for (const f of FIXTURES) {
    it(f.label, () => {
      const groups = extractPeerGroups("test", f.cdaText);
      expect(groups.length).toBeGreaterThanOrEqual(1);
      const first = groups[0];
      expect(first.members.length).toBeGreaterThanOrEqual(f.expectedMembersAtLeast);
      if (f.expectedType !== null) {
        expect(first.peer_group_type).toBe(f.expectedType);
      }
    });
  }
});
