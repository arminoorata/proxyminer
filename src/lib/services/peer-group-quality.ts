import type { PeerGroupMemberRow, ReviewStatus, VerificationStatus } from "@/lib/types";

// Curated set of tickers that have repeatedly appeared in peer panels
// only through false-positive alias extraction. Keep this in sync with
// scripts/audit-peer-panels.mjs when adding a new production finding.
export const SUSPECT_PEER_TICKERS = new Set([
  "TWLV", "KFII", "SLBT", "ABVE", "AMZE", "MLGO", "CRCL", "KVYO",
  "FIVE", "LRE", "CSTL", "YARIY", "CHOW", "JOSS", "NTPIF", "MVO",
  "GRDN", "MSIF", "BFS", "RNW", "CCEL", "CASS", "MASS", "BFST",
  "EFOI", "GLCP", "GCAN", "PERF", "PJT", "BETR", "HEPS", "RGCCF",
  "INDB", "PFGC", "FISI", "RHEP", "UHS", "STRA", "LSBA", "SEIC",
  "NUAI", "NYT", "BAESY", "WVE", "CTTH", "ICUI", "TBTC", "ASX",
  "SFWJ", "ULS", "STEW", "DRCT", "STRR", "VS", "SDHY", "PAYD",
  "OHCFF", "GDYN", "FCUV", "XHLD", "SXTP", "ALHC", "BYND", "VIR",
  "ALTG", "NMHI", "GAP", "GPS", "POOL", "MTCH", "EBAY", "BNAI",
  "PAID",
]);

// Parent/peer combinations that look suspicious by ticker alone but
// are confirmed real in the parent's published compensation peer group.
export const KNOWN_LEGIT_PEER_PAIRS = new Set([
  "fang|EXE",
  "psa|AMT",
  "spg|AMT",
]);

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
