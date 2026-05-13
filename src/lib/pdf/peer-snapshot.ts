/**
 * Peer-snapshot data assembly for the company PDF.
 *
 * Strategy: from the focal filing's disclosed peer groups, pick the
 * "primary" group (the executive-comp peer group, not the TSR /
 * stockholder-return chart group). Take members whose ticker resolved
 * to a company we have in our DB, fetch each peer's latest filing,
 * and emit a small row with CEO total / pay ratio / median employee
 * comp / comp-committee name.
 *
 * Capped at MAX_PEERS so the PDF stays a single page. Peers are taken
 * in disclosure order, which is typically alphabetical-by-name in
 * proxies — that gives a stable, scannable layout.
 *
 * Returns `[]` when:
 *   - the filing has no peer groups at all, or
 *   - no peer-group members resolved to a known company in our DB.
 * Callers should hide the panel when the result is empty.
 */
import type { FilingDetail } from "@/lib/types";

import { isCeoPosition } from "@/lib/exec/ceo";
import type { PeerColumn } from "./company-report";

const MAX_PEERS = 4;

export interface PeerSource {
  getCompany(id: string): Promise<{ id: string; ticker: string | null; name: string } | null>;
  getLatestFiling(id: string): Promise<FilingDetail | null>;
}

function formatTotal(v: string | null | undefined): string {
  if (!v) return "—";
  return v.startsWith("$") ? v : `$${v}`;
}

function pickPeerGroup(filing: FilingDetail) {
  // Prefer the explicit "primary" peer group (executive-comp peers).
  // Fall back to the first group disclosed. Indices marked
  // "stockholder-return" or "tsr" tend to be the wrong list for
  // exec-comp benchmarking; skip them when a primary is available.
  const primary = filing.peer_groups.find((g) => g.peer_group_type === "primary");
  if (primary) return primary;
  const nonReturn = filing.peer_groups.find(
    (g) => !/(stockholder|tsr|return|index)/i.test(g.peer_group_type ?? ""),
  );
  if (nonReturn) return nonReturn;
  return filing.peer_groups[0] ?? null;
}

function ceoTotalString(filing: FilingDetail | null): string {
  if (!filing || filing.executive_compensation.length === 0) return "—";
  const latestYear = Math.max(...filing.executive_compensation.map((r) => r.year));
  const ceo = filing.executive_compensation.find(
    (r) => r.year === latestYear && isCeoPosition(r.principal_position),
  );
  return ceo ? formatTotal(ceo.total) : "—";
}

function metricValue(filing: FilingDetail | null, normalized: string): string {
  if (!filing) return "—";
  const m = filing.metrics.find((x) => x.metric_name_normalized === normalized);
  return m?.observed_value ?? "—";
}

function policyValue(filing: FilingDetail | null, type: string): string {
  if (!filing) return "—";
  const p = filing.policies.find((x) => x.policy_type === type);
  return p?.normalized_value ?? p?.summary ?? "—";
}

/**
 * Pick up to 4 peers from the focal filing's disclosed peer group
 * and assemble the PDF-side display rows. The focal company itself
 * is excluded from the result (filings often list themselves in the
 * peer table for the chart, which isn't useful here).
 */
export async function assemblePeerSnapshot(
  focalCompanyId: string,
  filing: FilingDetail,
  source: PeerSource,
): Promise<PeerColumn[]> {
  const group = pickPeerGroup(filing);
  if (!group || group.members.length === 0) return [];

  // Dedupe in order, exclude the focal company, only keep resolved peers.
  const seen = new Set<string>();
  seen.add(focalCompanyId);
  const candidates: string[] = [];
  for (const m of group.members) {
    const id = m.company_id_resolved;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push(id);
    if (candidates.length >= MAX_PEERS) break;
  }
  if (candidates.length === 0) return [];

  const rows = await Promise.all(
    candidates.map(async (id) => {
      const [peerCompany, peerFiling] = await Promise.all([
        source.getCompany(id),
        source.getLatestFiling(id),
      ]);
      if (!peerCompany) return null;
      const ticker = peerCompany.ticker?.toUpperCase() ?? peerCompany.id.toUpperCase();
      return {
        ticker,
        name: peerCompany.name,
        ceoTotal: ceoTotalString(peerFiling),
        payRatio: metricValue(peerFiling, "ceo_pay_ratio"),
        medianEmp: metricValue(peerFiling, "median_employee_compensation"),
        compCommittee: policyValue(peerFiling, "compensation_committee"),
      } satisfies PeerColumn;
    }),
  );
  return rows.filter((r): r is PeerColumn => r !== null);
}
