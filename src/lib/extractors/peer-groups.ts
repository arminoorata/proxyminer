/**
 * Peer group extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/peer_extractor.py (681 lines).
 *
 * STATUS: scaffold + smallest-viable patterns. Full port is in flight.
 *
 * The Python version does:
 *   - regex sweep over the CD&A text to find peer-group disclosure
 *     blocks (multiple narrative patterns: "our compensation peer
 *     group consists of", "the committee selected the following
 *     companies", Adobe/Apple/Qualcomm-style variants)
 *   - extracts company-name fragments from list patterns + tables
 *   - resolves names against a SEC ticker map snapshot for
 *     company_id / ticker / cik / resolution_confidence
 *   - keeps unresolved raw names so QA can fix the mapping
 *
 * Per Decisions D-002 the company-resolution layer must load the
 * frozen `.fixtures/ticker_map.json` snapshot (P1-5). Loading happens
 * in resolveCompanyName below.
 *
 * The full pattern catalogue is in the Python file at
 * `/srv/projects/ProxyMiner/apps/api/app/services/peer_extractor.py`.
 * We port one anchor pattern here; subsequent patterns land as
 * dedicated functions exporting the same shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PeerGroupRow, PeerGroupMemberRow } from "@/lib/types";

export const PEER_EXTRACTOR_VERSION = "peer_extractor.ts.v1";

interface TickerMapEntry {
  cik: string;
  ticker: string;
  name: string;
  all_tickers?: string[];
}

let TICKER_MAP: Map<string, TickerMapEntry> | null = null;

function loadTickerMap(): Map<string, TickerMapEntry> {
  if (TICKER_MAP) return TICKER_MAP;
  const path = join(process.cwd(), ".fixtures", "ticker_map.json");
  if (!existsSync(path)) {
    TICKER_MAP = new Map();
    return TICKER_MAP;
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, TickerMapEntry>;
  TICKER_MAP = new Map(
    Object.entries(data).flatMap(([key, entry]) => {
      const keys = [
        key.toLowerCase(),
        entry.name.toLowerCase(),
      ];
      return keys.map((k) => [k, entry] as const);
    }),
  );
  return TICKER_MAP;
}

export function resolveCompanyName(rawName: string): {
  resolved_name: string | null;
  ticker: string | null;
  cik: string | null;
  company_id: string | null;
  confidence: number;
} {
  const map = loadTickerMap();
  const lower = rawName.toLowerCase().replace(/\s+/g, " ").trim();
  const direct = map.get(lower);
  if (direct) {
    return {
      resolved_name: direct.name,
      ticker: direct.ticker,
      cik: direct.cik,
      company_id: direct.ticker.toLowerCase(),
      confidence: 0.95,
    };
  }
  // Loose contains match — last-resort.
  for (const [key, entry] of map.entries()) {
    if (key.length < 4) continue;
    if (lower.includes(key) || key.includes(lower)) {
      return {
        resolved_name: entry.name,
        ticker: entry.ticker,
        cik: entry.cik,
        company_id: entry.ticker.toLowerCase(),
        confidence: 0.7,
      };
    }
  }
  return {
    resolved_name: null,
    ticker: null,
    cik: null,
    company_id: null,
    confidence: 0,
  };
}

// Anchor pattern: "our compensation peer group consists of …".
// The full extractor catalogues 8+ patterns; this is the smallest
// regression-safe one to land. The remaining patterns will be added
// in a follow-up commit, with the Python source as the spec.
const PEER_BLOCK_PATTERNS: RegExp[] = [
  /(?:our|the)\s+(?:compensation\s+)?peer\s+group\s+(?:consists\s+of|is\s+comprised\s+of|includes)\s*([^.]+\.)/gi,
  /(?:committee\s+)?selected\s+the\s+following\s+(?:peer\s+)?companies(?:\s*[:,]\s*)?([^.]+\.)/gi,
];

/**
 * Extract peer groups from a CD&A text snippet. Returns the row shape
 * with members already resolved.
 */
export function extractPeerGroups(
  filingId: string,
  cdaText: string,
): Omit<PeerGroupRow, "id" | "section_id">[] {
  const groups: Omit<PeerGroupRow, "id" | "section_id">[] = [];
  for (const pattern of PEER_BLOCK_PATTERNS) {
    for (const match of cdaText.matchAll(pattern)) {
      const block = match[1] ?? "";
      const memberNames = block
        .split(/[,;]|\band\b/)
        .map((s) =>
          s
            .replace(/^[\s·•·]+|[\s·.;:]+$/g, "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((s) => s.length >= 2 && /[A-Za-z]/.test(s));
      if (memberNames.length < 3) continue;
      const members: Omit<PeerGroupMemberRow, "id" | "peer_group_id">[] = memberNames.map(
        (raw) => {
          const r = resolveCompanyName(raw);
          return {
            company_name_raw: raw,
            company_id_resolved: r.company_id,
            company_name_resolved: r.resolved_name,
            ticker_resolved: r.ticker,
            cik_resolved: r.cik,
            resolution_confidence: r.confidence,
          };
        },
      );
      groups.push({
        filing_id: filingId,
        peer_group_name: null,
        peer_group_type: "compensation",
        disclosed_year: null,
        selection_rationale: null,
        source_excerpt: block.slice(0, 800),
        confidence_score: 0.7,
        extractor_version: PEER_EXTRACTOR_VERSION,
        extraction_method: "narrative-anchor",
        source_document_name: null,
        source_document_sha: null,
        verification_status: "machine_extracted",
        review_status: "unreviewed",
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        members: members as PeerGroupMemberRow[],
      });
      break; // one peer block per pattern is plenty for v1
    }
  }
  return groups;
}
