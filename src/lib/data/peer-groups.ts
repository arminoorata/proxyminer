import type { PeerGroupRow } from "@/lib/types";

export interface FilingDetailOptions {
  includeFlaggedPeerGroups?: boolean;
}

export function isPublicPeerGroup(
  group: Pick<PeerGroupRow, "review_status" | "verification_status">,
): boolean {
  return group.review_status !== "flagged" && group.verification_status !== "rejected";
}

export function peerGroupsForPublic<T extends Pick<PeerGroupRow, "review_status" | "verification_status">>(
  groups: T[],
  options: FilingDetailOptions = {},
): T[] {
  if (options.includeFlaggedPeerGroups) return groups;
  return groups.filter(isPublicPeerGroup);
}
