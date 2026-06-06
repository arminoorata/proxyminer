/**
 * Merge peer groups extracted via the four independent paths (CD&A
 * text, HTML table, ticker-inline, suffix-enumeration).
 *
 * A filing's single real peer group often surfaces through more than
 * one path — e.g. a CD&A "the peer group was composed of:" sentence AND
 * the same list rendered as an HTML table. When two groups clearly
 * describe the same set (member overlap >= MERGE_OVERLAP) we collapse
 * them into one row.
 *
 * Which one wins: historically the merge always kept the FIRST
 * (text-extracted) group and dropped the other. That silently lost real
 * peers whenever the text path stopped at a block boundary and the
 * HTML/suffix path read the whole list — ADBE FY2026's text path found
 * 14 of 19 peers, so the merge discarded the complete 19-member group
 * (losing Alphabet / Netflix / Oracle / Palo Alto Networks / ServiceNow).
 *
 * Narrow fix: when a secondary group is a STRICT, FULLY-RESOLVED
 * SUPERSET of the primary it overlaps, adopt the secondary's members
 * (keeping the primary's richer metadata — name / year / type /
 * rationale). "Superset" guarantees we never drop a primary member;
 * "fully resolved" keeps us from trading a clean group for one padded
 * with unresolved name fragments. Any non-superset overlap keeps the
 * prior behavior (drop the secondary as a duplicate), so the merge does
 * not balloon every filing or fold two genuinely different groups
 * together.
 */
import type { PeerGroupRow } from "@/lib/types";

type ExtractedPeerGroup = Omit<PeerGroupRow, "id" | "section_id">;
type Member = ExtractedPeerGroup["members"][number];

/** Two groups are "the same group" when their member sets overlap by
 * at least this fraction (intersection / larger set). */
export const MERGE_OVERLAP = 0.6;

function memberId(m: Member): string {
  return m.company_id_resolved ?? m.company_name_raw;
}

function idsOf(g: ExtractedPeerGroup): Set<string> {
  return new Set(g.members.map(memberId));
}

function overlapFraction(a: Set<string>, b: Set<string>): number {
  const denom = Math.max(a.size, b.size);
  if (denom === 0) return 0;
  let intersect = 0;
  for (const id of a) if (b.has(id)) intersect++;
  return intersect / denom;
}

/** True when every id in `inner` is present in `outer`. */
function isSuperset(outer: Set<string>, inner: Set<string>): boolean {
  for (const id of inner) if (!outer.has(id)) return false;
  return true;
}

export function mergePeerGroups(
  primary: ExtractedPeerGroup[],
  secondary: ExtractedPeerGroup[],
): ExtractedPeerGroup[] {
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;

  // Shallow-copy primaries so we can swap a group's member list without
  // mutating the caller's objects.
  const out: ExtractedPeerGroup[] = primary.map((g) => ({
    ...g,
    members: [...g.members],
  }));
  const outIds: Set<string>[] = out.map(idsOf);

  for (const s of secondary) {
    const sIds = idsOf(s);
    let targetIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (overlapFraction(sIds, outIds[i]) >= MERGE_OVERLAP) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx === -1) {
      // Genuinely distinct group — append and track its ids so a later
      // secondary group can match against it too.
      out.push({ ...s, members: [...s.members] });
      outIds.push(new Set(sIds));
      continue;
    }
    // Same group. Adopt the secondary's members ONLY when it is a
    // strictly larger, fully-resolved superset of the primary; that is
    // the "text stopped early, the table has the whole list" case. Any
    // other overlap is treated as a duplicate and dropped (prior
    // behavior), so distinct groups never fuse and unresolved name
    // fragments never pad a clean group.
    const have = outIds[targetIdx];
    const secondaryIsCleanSuperset =
      sIds.size > have.size &&
      isSuperset(sIds, have) &&
      s.members.every((m) => m.company_id_resolved != null);
    if (secondaryIsCleanSuperset) {
      out[targetIdx] = { ...out[targetIdx], members: [...s.members] };
      outIds[targetIdx] = new Set(sIds);
    }
  }
  return out;
}

/**
 * Drop the filer itself from its own peer groups.
 *
 * A company is never its own peer, but the extractors occasionally
 * resolve the filer's own name out of a heading or intro sentence ("the
 * Salesforce peer group consists of …") and emit it as a member. This
 * surfaced as Salesforce in CRM's group, NETFLIX in NFLX's, and
 * QUALCOMM in QCOM's. Filtering by resolved company_id is always safe:
 * the filer's id can only match the filer. Groups left empty are
 * dropped.
 */
export function dropFilerSelf(
  groups: ExtractedPeerGroup[],
  filerCompanyId: string | null | undefined,
): ExtractedPeerGroup[] {
  if (!filerCompanyId) return groups;
  return groups
    .map((g) => ({
      ...g,
      members: g.members.filter((m) => m.company_id_resolved !== filerCompanyId),
    }))
    .filter((g) => g.members.length > 0);
}
