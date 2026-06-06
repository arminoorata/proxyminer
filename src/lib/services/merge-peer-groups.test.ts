/**
 * Unit tests for mergePeerGroups — the union step that collapses the
 * four extractor paths into one set of peer groups.
 *
 * Regression target: the merge used to keep the first (text) group and
 * drop any other group overlapping it >= 60%, silently losing the peers
 * a fuller HTML/suffix extraction recovered (ADBE FY2026 lost Alphabet /
 * Netflix / Oracle / Palo Alto Networks / ServiceNow). The fix adopts a
 * secondary group ONLY when it is a strict, fully-resolved superset of
 * the primary it overlaps; everything else keeps the prior drop-the-dup
 * behavior so distinct groups never fuse and unresolved fragments never
 * pad a clean group.
 */
import { describe, expect, it } from "vitest";

import { dropFilerSelf, mergePeerGroups } from "./merge-peer-groups";
import type { PeerGroupRow } from "@/lib/types";

type Group = Omit<PeerGroupRow, "id" | "section_id">;

function member(id: string | null, raw = id ?? "?") {
  return {
    company_name_raw: raw,
    company_id_resolved: id,
    company_name_resolved: id ? id.toUpperCase() : null,
    ticker_resolved: id ? id.toUpperCase() : null,
    cik_resolved: id ? `cik-${id}` : null,
    resolution_confidence: id ? 0.99 : null,
  };
}

function group(name: string, ids: (string | null)[], extra: Partial<Group> = {}): Group {
  return {
    filing_id: "f",
    peer_group_name: name,
    peer_group_type: null,
    disclosed_year: null,
    selection_rationale: null,
    source_excerpt: "",
    confidence_score: 0.9,
    members: ids.map((i) => member(i)) as Group["members"],
    extractor_version: "test",
    extraction_method: "test",
    source_document_name: null,
    source_document_sha: null,
    verification_status: "machine_extracted",
    review_status: "unreviewed",
    reviewed_by: null,
    reviewed_at: null,
    ...extra,
  } as Group;
}

const ids = (g: Group) => g.members.map((m) => m.company_id_resolved).sort();

describe("mergePeerGroups", () => {
  it("adopts a strict, fully-resolved superset (ADBE shape)", () => {
    const text = [group("2025 Peer Group", ["a", "b", "c", "d"], { disclosed_year: 2025 })];
    const html = [group("Peer Group", ["a", "b", "c", "d", "e", "panw"])];
    const out = mergePeerGroups(text, html);
    expect(out).toHaveLength(1);
    expect(ids(out[0])).toEqual(["a", "b", "c", "d", "e", "panw"]);
    // Primary metadata wins.
    expect(out[0].peer_group_name).toBe("2025 Peer Group");
    expect(out[0].disclosed_year).toBe(2025);
  });

  it("drops a non-superset overlap (never fuses two different groups)", () => {
    // overlap 3/4 = 0.75 >= 0.6, but secondary has a member (e) the
    // primary lacks AND is missing one the primary has (d) → not a
    // superset, so it is treated as a duplicate and dropped.
    const primary = [group("P", ["a", "b", "c", "d"])];
    const secondary = [group("S", ["a", "b", "c", "e"])];
    const out = mergePeerGroups(primary, secondary);
    expect(out).toHaveLength(1);
    expect(ids(out[0])).toEqual(["a", "b", "c", "d"]); // unchanged, no "e"
  });

  it("keeps genuinely distinct groups (no overlap)", () => {
    const primary = [group("Primary", ["a", "b", "c"])];
    const secondary = [group("Secondary", ["x", "y", "z"])];
    const out = mergePeerGroups(primary, secondary);
    expect(out).toHaveLength(2);
  });

  it("does NOT adopt a superset that contains an unresolved member", () => {
    const text = [group("Clean", ["a", "b", "c"])];
    // superset by id, but "d" is unresolved (null id) → reject, keep clean group.
    const padded = [group("Padded", ["a", "b", "c", null])];
    const out = mergePeerGroups(text, padded);
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(3);
    expect(ids(out[0])).toEqual(["a", "b", "c"]);
  });

  it("does not grow when the secondary equals the primary", () => {
    const a = [group("P", ["a", "b", "c"])];
    const b = [group("S", ["a", "b", "c"])];
    const out = mergePeerGroups(a, b);
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(3);
  });

  it("preserves two distinct primary groups and only grows the matching one (Meta shape)", () => {
    // Two real primary groups with disjoint members (e.g. a primary and
    // a secondary peer group) must both survive; a fuller secondary
    // extraction only supersets ONE of them.
    const primaries = [
      group("2024 Primary", ["a", "b", "c", "d"], { disclosed_year: 2024 }),
      group("2024 Secondary", ["x", "y", "z"], { disclosed_year: 2024 }),
    ];
    const supersetOfFirst = [group("P", ["a", "b", "c", "d", "e"])];
    const out = mergePeerGroups(primaries, supersetOfFirst);
    expect(out).toHaveLength(2);
    const first = out.find((g) => g.peer_group_name === "2024 Primary")!;
    const second = out.find((g) => g.peer_group_name === "2024 Secondary")!;
    expect(ids(first)).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(second)).toEqual(["x", "y", "z"]); // untouched
  });

  it("returns the other list when one side is empty", () => {
    const g = [group("P", ["a", "b", "c"])];
    expect(mergePeerGroups(g, [])).toBe(g);
    expect(mergePeerGroups([], g)).toBe(g);
  });
});

describe("dropFilerSelf", () => {
  it("removes the filer from its own peer group (CRM/NFLX/QCOM shape)", () => {
    const groups = [group("Peer Group", ["a", "b", "crm", "c"])];
    const out = dropFilerSelf(groups, "crm");
    expect(out).toHaveLength(1);
    expect(ids(out[0])).toEqual(["a", "b", "c"]);
  });

  it("leaves groups untouched when the filer is not a member", () => {
    const groups = [group("Peer Group", ["a", "b", "c"])];
    const out = dropFilerSelf(groups, "msft");
    expect(ids(out[0])).toEqual(["a", "b", "c"]);
  });

  it("drops a group that becomes empty after removing the filer", () => {
    const groups = [group("Solo", ["crm"]), group("Real", ["a", "b", "c"])];
    const out = dropFilerSelf(groups, "crm");
    expect(out).toHaveLength(1);
    expect(out[0].peer_group_name).toBe("Real");
  });

  it("is a no-op when no filer id is supplied", () => {
    const groups = [group("Peer Group", ["a", "b", "c"])];
    expect(dropFilerSelf(groups, null)).toBe(groups);
    expect(dropFilerSelf(groups, undefined)).toBe(groups);
  });
});
