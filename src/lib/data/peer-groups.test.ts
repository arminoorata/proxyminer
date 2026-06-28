import { describe, expect, it } from "vitest";

import { isPublicPeerGroup, peerGroupsForPublic } from "./peer-groups";
import type { PeerGroupRow } from "@/lib/types";

function group(
  review_status: PeerGroupRow["review_status"],
  verification_status: PeerGroupRow["verification_status"],
): PeerGroupRow {
  return {
    id: `${review_status}-${verification_status}`,
    filing_id: "filing",
    section_id: null,
    peer_group_name: "Peer group",
    peer_group_type: "primary",
    disclosed_year: 2026,
    selection_rationale: null,
    source_excerpt: "",
    confidence_score: 0.9,
    extractor_version: "test",
    extraction_method: "test",
    source_document_name: null,
    source_document_sha: null,
    verification_status,
    review_status,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    members: [],
  };
}

describe("peer group public filtering", () => {
  it("exposes machine-extracted and reviewed groups by default", () => {
    expect(isPublicPeerGroup(group("unreviewed", "machine_extracted"))).toBe(true);
    expect(isPublicPeerGroup(group("reviewed", "verified"))).toBe(true);
  });

  it("hides rejected or flagged groups from public reads", () => {
    expect(isPublicPeerGroup(group("flagged", "machine_extracted"))).toBe(false);
    expect(isPublicPeerGroup(group("unreviewed", "rejected"))).toBe(false);
    expect(isPublicPeerGroup(group("flagged", "rejected"))).toBe(false);
  });

  it("lets the review console opt into flagged rows", () => {
    const clean = group("unreviewed", "machine_extracted");
    const flagged = group("flagged", "rejected");

    expect(peerGroupsForPublic([clean, flagged])).toEqual([clean]);
    expect(
      peerGroupsForPublic([clean, flagged], { includeFlaggedPeerGroups: true }),
    ).toEqual([clean, flagged]);
  });
});
