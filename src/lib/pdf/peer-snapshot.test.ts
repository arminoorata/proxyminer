/**
 * Unit tests for `assemblePeerSnapshot`. No DB; the data-source
 * dependency is mocked. Each test exercises one selection rule:
 *   - prefer the primary peer group
 *   - skip the focal company if it's listed in its own peer table
 *   - only include peers whose ticker resolved (company_id_resolved)
 *   - cap at 4 peers
 *   - empty when no resolved members
 */
import { describe, expect, it } from "vitest";

import { assemblePeerSnapshot, type PeerSource } from "./peer-snapshot";
import type {
  CompanyRow,
  ExecutiveCompRow,
  FilingDetail,
  MetricFactRow,
  PeerGroupMemberRow,
  PeerGroupRow,
  PolicyFactRow,
} from "@/lib/types";

function makeCompany(id: string, ticker: string, name: string): CompanyRow {
  return {
    id,
    cik: "0000000000",
    ticker,
    name,
    sector: null,
    industry: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as CompanyRow;
}

function makeFiling(
  id: string,
  companyId: string,
  year: number,
  overrides: Partial<FilingDetail> = {},
): FilingDetail {
  const ceo: ExecutiveCompRow = {
    executive_name: "Test CEO",
    principal_position: "Chief Executive Officer",
    year,
    salary: "1,000,000",
    bonus: null,
    stock_awards: "10,000,000",
    option_awards: null,
    non_equity_incentive_plan_compensation: "2,000,000",
    all_other_compensation: "100,000",
    total: "13,100,000",
    source_excerpt: "",
  };
  return {
    id,
    company_id: companyId,
    accession_number: "x",
    form_type: "DEF 14A",
    filing_date: new Date(`${year}-04-01`),
    filing_year: year,
    primary_document_url: null,
    primary_document_name: null,
    source_index_url: null,
    sections: [],
    policies: [],
    peer_groups: [],
    metrics: [],
    executive_compensation: [ceo],
    ...overrides,
  } as unknown as FilingDetail;
}

function member(
  raw: string,
  resolved: string | null,
  name: string | null = null,
): PeerGroupMemberRow {
  return {
    id: 0,
    peer_group_id: 0,
    company_name_raw: raw,
    company_id_resolved: resolved,
    company_name_resolved: name,
    ticker_resolved: resolved?.toUpperCase() ?? null,
    cik_resolved: null,
    resolution_confidence: resolved ? 0.9 : null,
  };
}

function peerGroup(
  type: string,
  members: PeerGroupMemberRow[],
): PeerGroupRow {
  return {
    id: 0,
    filing_id: "x",
    section_id: null,
    peer_group_name: type,
    peer_group_type: type,
    disclosed_year: 2025,
    selection_rationale: null,
    source_excerpt: "",
    confidence_score: 0.9,
    members,
  } as unknown as PeerGroupRow;
}

function makeSource(
  companies: Record<string, CompanyRow>,
  filings: Record<string, FilingDetail>,
): PeerSource {
  return {
    async getCompany(id) {
      const c = companies[id];
      if (!c) return null;
      return { id: c.id, ticker: c.ticker, name: c.name };
    },
    async getLatestFiling(id) {
      return filings[id] ?? null;
    },
  };
}

describe("assemblePeerSnapshot", () => {
  it("prefers the primary peer group over TSR/stockholder-return groups", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("stockholder-return", [member("Wrong Co", "wrong")]),
        peerGroup("primary", [member("Right Co", "right")]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource(
      {
        right: makeCompany("right", "RGHT", "Right Co"),
        wrong: makeCompany("wrong", "WRNG", "Wrong Co"),
      },
      {
        right: makeFiling("r-2025", "right", 2025),
        wrong: makeFiling("w-2025", "wrong", 2025),
      },
    ));
    expect(peers).toHaveLength(1);
    expect(peers[0].ticker).toBe("RGHT");
  });

  it("excludes the focal company from its own peer table", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("primary", [
          member("Focal Co", "focal"),       // should be excluded
          member("Other Co", "other"),
        ]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource(
      {
        focal: makeCompany("focal", "FOCL", "Focal Co"),
        other: makeCompany("other", "OTHR", "Other Co"),
      },
      {
        focal: makeFiling("f-2025", "focal", 2025),
        other: makeFiling("o-2025", "other", 2025),
      },
    ));
    expect(peers.map((p) => p.ticker)).toEqual(["OTHR"]);
  });

  it("skips peers whose ticker didn't resolve", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("primary", [
          member("Resolved Co", "resolved"),
          member("Unresolved Co", null),     // skipped
          member("Other Resolved Co", "other"),
        ]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource(
      {
        resolved: makeCompany("resolved", "RES", "Resolved Co"),
        other: makeCompany("other", "OTH", "Other Resolved Co"),
      },
      {
        resolved: makeFiling("r-2025", "resolved", 2025),
        other: makeFiling("o-2025", "other", 2025),
      },
    ));
    expect(peers.map((p) => p.ticker)).toEqual(["RES", "OTH"]);
  });

  it("caps at 4 peers", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("primary", [
          member("A", "a"), member("B", "b"), member("C", "c"),
          member("D", "d"), member("E", "e"), member("F", "f"),
        ]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource(
      {
        a: makeCompany("a", "A", "A Co"),
        b: makeCompany("b", "B", "B Co"),
        c: makeCompany("c", "C", "C Co"),
        d: makeCompany("d", "D", "D Co"),
        e: makeCompany("e", "E", "E Co"),
        f: makeCompany("f", "F", "F Co"),
      },
      {
        a: makeFiling("ax", "a", 2025),
        b: makeFiling("bx", "b", 2025),
        c: makeFiling("cx", "c", 2025),
        d: makeFiling("dx", "d", 2025),
        e: makeFiling("ex", "e", 2025),
        f: makeFiling("fx", "f", 2025),
      },
    ));
    expect(peers).toHaveLength(4);
  });

  it("returns empty when no peer group has resolved members", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("primary", [member("Unknown Co", null)]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource({}, {}));
    expect(peers).toEqual([]);
  });

  it("returns empty when filing has no peer groups", async () => {
    const filing = makeFiling("focal-1", "focal", 2025, { peer_groups: [] });
    const peers = await assemblePeerSnapshot("focal", filing, makeSource({}, {}));
    expect(peers).toEqual([]);
  });

  it("populates ceoTotal, payRatio, medianEmp, compCommittee from each peer's latest filing", async () => {
    const peerMetrics: MetricFactRow[] = [
      {
        id: 1, filing_id: "p1", section_id: null,
        metric_name_raw: "CEO Pay Ratio", metric_name_normalized: "ceo_pay_ratio",
        metric_category: "pay_ratio", plan_type: null,
        observed_value: "250 to 1",
        source_excerpt: "",
        confidence_score: 0.9,
        extractor_version: "x", extraction_method: "regex-fact-rule",
        source_document_name: null, source_document_sha: null,
        verification_status: "machine_extracted",
        review_status: "unreviewed",
        reviewed_by: null, reviewed_at: null, review_notes: null,
      } as unknown as MetricFactRow,
      {
        id: 2, filing_id: "p1", section_id: null,
        metric_name_raw: "Median Employee Compensation", metric_name_normalized: "median_employee_compensation",
        metric_category: "pay_ratio", plan_type: null,
        observed_value: "$200,000",
        source_excerpt: "",
        confidence_score: 0.9,
        extractor_version: "x", extraction_method: "regex-fact-rule",
        source_document_name: null, source_document_sha: null,
        verification_status: "machine_extracted",
        review_status: "unreviewed",
        reviewed_by: null, reviewed_at: null, review_notes: null,
      } as unknown as MetricFactRow,
    ];
    const peerPolicies: PolicyFactRow[] = [
      {
        id: 1, filing_id: "p1", section_id: null,
        policy_type: "compensation_committee",
        normalized_value: "People and Compensation Committee",
        summary: "", source_excerpt: "",
        confidence_score: 0.9,
        extractor_version: "x", extraction_method: "regex-fact-rule",
        source_document_name: null, source_document_sha: null,
        verification_status: "machine_extracted",
        review_status: "unreviewed",
        reviewed_by: null, reviewed_at: null, review_notes: null,
      } as unknown as PolicyFactRow,
    ];
    const peerFiling = makeFiling("p-2025", "peer", 2025, {
      metrics: peerMetrics,
      policies: peerPolicies,
    });

    const focal = makeFiling("focal-1", "focal", 2025, {
      peer_groups: [
        peerGroup("primary", [member("Peer Co", "peer")]),
      ],
    });
    const peers = await assemblePeerSnapshot("focal", focal, makeSource(
      { peer: makeCompany("peer", "PEER", "Peer Co") },
      { peer: peerFiling },
    ));
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      ticker: "PEER",
      name: "Peer Co",
      ceoTotal: "$13,100,000",
      payRatio: "250 to 1",
      medianEmp: "$200,000",
      compCommittee: "People and Compensation Committee",
    });
  });
});
