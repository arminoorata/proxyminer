import type { PeerGroupMemberRow, ReviewStatus, VerificationStatus } from "@/lib/types";
import peerGroupQualityData from "./peer-group-quality-data.json";

export const SUSPECT_PEER_TICKERS = new Set(peerGroupQualityData.suspectPeerTickers);
export const KNOWN_LEGIT_PEER_PAIRS = new Set(peerGroupQualityData.knownLegitPeerPairs);

export interface PeerGroupQuality {
  reviewStatus: ReviewStatus;
  verificationStatus: VerificationStatus;
  reviewNotes: string | null;
  suspectTickers: string[];
}

function memberTicker(member: Pick<PeerGroupMemberRow, "ticker_resolved" | "company_id_resolved">): string | null {
  const raw = member.ticker_resolved ?? member.company_id_resolved;
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function classifyPeerMember(
  parentCompanyId: string,
  member: Pick<PeerGroupMemberRow, "ticker_resolved" | "company_id_resolved">,
): "legit" | "legit-allowlist" | "suspect" {
  const ticker = memberTicker(member);
  if (!ticker) return "legit";
  const pairKey = `${parentCompanyId.toLowerCase()}|${ticker}`;
  if (KNOWN_LEGIT_PEER_PAIRS.has(pairKey)) return "legit-allowlist";
  if (SUSPECT_PEER_TICKERS.has(ticker)) return "suspect";
  return "legit";
}

export function auditPeerGroupQuality(
  parentCompanyId: string,
  members: Pick<PeerGroupMemberRow, "ticker_resolved" | "company_id_resolved">[],
): PeerGroupQuality {
  const suspectTickers = [
    ...new Set(
      members
        .filter((member) => classifyPeerMember(parentCompanyId, member) === "suspect")
        .map(memberTicker)
        .filter((ticker): ticker is string => ticker !== null),
    ),
  ].sort();

  if (suspectTickers.length === 0) {
    return {
      reviewStatus: "unreviewed",
      verificationStatus: "machine_extracted",
      reviewNotes: null,
      suspectTickers: [],
    };
  }

  return {
    reviewStatus: "flagged",
    verificationStatus: "rejected",
    reviewNotes: `Auto-quarantined peer group: suspect ticker(s) ${suspectTickers.join(", ")}.`,
    suspectTickers,
  };
}
