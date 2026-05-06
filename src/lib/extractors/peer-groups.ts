/**
 * Peer group extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/peer_extractor.py.
 *
 * Faithful 1:1 port of the four block-level extraction patterns
 * (headed group / included group / peer-company block / approved
 * block), plus the CompanyResolver that builds an alias index from
 * the SEC ticker map and resolves narrative company names back to
 * canonical (company_id, ticker, cik, confidence).
 *
 * The ticker map is loaded from `.fixtures/ticker_map.json` per
 * D-002 P1-5. Loading is lazy + memoized.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PeerGroupRow, PeerGroupMemberRow } from "@/lib/types";

export const PEER_EXTRACTOR_VERSION = "peer_extractor.ts.v1";

// ── Block patterns (mirror peer_extractor.py:10-49) ──────────────────

const HEADED_GROUP_PATTERN =
  /(?:(?:our|the)\s+)?(?:(?:fiscal|calendar)\s+)?(?:(?<year>20\d{2})\s+)?(?:(?<kind>primary|secondary)\s+)?(?:(?:compensation)\s+)?peer group\b/i;
const INCLUDED_GROUP_PATTERN =
  /(?<prefix>(?:(?:our|the|a|an)\s+)?(?:(?<current>current)\s+)?(?:(?<year>20\d{2})\s+)?(?<kind>primary|secondary)\s+(?:peer\s+)?group\s+include(?:s|d)?)\s+(?<body>.+?)(?:\.\s|$)/i;
const GROUP_REFERENCE_PATTERN =
  /(?:(?:our|the|a|an)\s+)?(?:(?<year>20\d{2})\s+)?(?<kind>primary|secondary)\s+peer group\b/i;
const THIS_GROUP_INCLUDED_PATTERN =
  /(?<prefix>(?:this|the|such)\s+group\s+include(?:s|d)?)\s+(?<body>.+?)(?:\.\s|$)/i;
const SELECTED_PEER_COMPANIES_PATTERN =
  /(?<prefix>(?:the\s+compensation\s+committee\s+)?selected\s+the\s+following\s+peer\s+companies\s+for\s+(?<year>20\d{2})(?:\s+compensation)?)\s*:?\s*(?<body>.+)$/i;
const COMPENSATION_PEER_GROUP_LIST_PATTERN =
  /(?<prefix>for\s+(?:fiscal\s+)?(?<year>20\d{2}),?\s+the\s+companies\s+comprising\s+the\s+(?:compensation\s+)?peer\s+group\s+consisted\s+of)\s*:?\s*(?<body>.+)$/i;
const APPROVED_BELOW_PEER_GROUP_PATTERN =
  /approved\s+the\s+below\s+peer\s+group\s+for\s+(?:fiscal\s+year\s+)?(?<year>20\d{2})\.\s*peer\s+group\s+for\s+(?:fiscal\s+year\s+)?\k<year>\s+(?<body>.+?)(?=(?:in\s+response\s+to\s+stockholder\s+feedback|compensia\s+prepares|with\s+regard\s+to\s+peer\s+group|compensation\s+risk\s+assessment|$))/i;
const APPROVED_PEER_COMPANIES_PATTERN =
  /(?<prefix>peer\s+companies(?:\s+that\s+the\s+.+?)?\s+approved\s+.+?\s+for\s+(?:consideration\s+in\s+determining\s+.+?\s+for\s+)?fiscal\s+(?<year>20\d{2}))/i;

const RATIONALE_HINTS = [
  "consists of",
  "composed of",
  "selection criteria",
  "selected based on",
  "to serve as the market reference point",
];
const CORPORATE_SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company",
  "plc", "ltd", "limited", "de", "holdings", "holding", "group",
  "sa", "ag", "nv", "the",
]);
const SHORT_NAME_SUFFIXES = new Set([
  "com", "systems", "platforms", "technologies", "communications",
  "pharmaceuticals", "therapeutics",
]);
const COMMON_NAME_WORDS = new Set([
  "group", "holdings", "holding", "company", "companies",
  "corp", "corporation", "inc", "co", "plc", "ltd",
]);

// ── Ticker map loader ────────────────────────────────────────────────

interface TickerMapEntry {
  cik?: string;
  cik_str?: string | number;
  ticker?: string;
  title?: string;
  name?: string;
  all_tickers?: string[];
}

let TICKER_MAP_CACHE: Record<string, TickerMapEntry> | null = null;

function loadTickerMap(): Record<string, TickerMapEntry> {
  if (TICKER_MAP_CACHE) return TICKER_MAP_CACHE;
  const path = join(process.cwd(), ".fixtures", "ticker_map.json");
  if (!existsSync(path)) {
    TICKER_MAP_CACHE = {};
    return TICKER_MAP_CACHE;
  }
  TICKER_MAP_CACHE = JSON.parse(readFileSync(path, "utf8")) as Record<string, TickerMapEntry>;
  return TICKER_MAP_CACHE;
}

// ── Helpers (mirror peer_extractor.py:609-682) ───────────────────────

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenizeName(value: string): string[] {
  let cleaned = value.normalize("NFKD");
  cleaned = cleaned.replace(/&/g, " & ");
  cleaned = cleaned.replace(/[/.,'’()]+/g, " ");
  cleaned = cleaned.replace(/[^\w&\- ]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.split(" ") : [];
}

function normalizeName(value: string): string {
  let s = value.normalize("NFKD");
  s = s.replace(/&/g, " and ");
  s = s.replace(/\+/g, " plus ");
  s = s.replace(/’/g, "'");
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function findAlias(normalizedText: string, alias: string): number {
  let start = normalizedText.indexOf(alias);
  while (start !== -1) {
    const end = start + alias.length;
    const before = start > 0 ? normalizedText[start - 1] : " ";
    const after = end < normalizedText.length ? normalizedText[end] : " ";
    if (before === " " && after === " ") return start;
    start = normalizedText.indexOf(alias, start + 1);
  }
  return -1;
}

function allowShortAlias(alias: string): boolean {
  const c = alias.replace(/ /g, "");
  return c.length >= 2 && /\d/.test(c);
}

function matchesPeerGroupReference(loweredText: string, peerGroupType: string | null): boolean {
  if (!loweredText.includes("peer group")) return false;
  if (peerGroupType === null) return true;
  return loweredText.includes(peerGroupType);
}

function looksLikeRationaleText(text: string): boolean {
  const lowered = compact(text).toLowerCase();
  if (!lowered) return false;
  const head = lowered.slice(0, 160);
  return RATIONALE_HINTS.some((h) => head.includes(h));
}

function stripLeadingDescriptor(text: string): string {
  let cleaned = text.replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, "");
  const lowered = cleaned.toLowerCase();
  for (const d of ["technology", "general industry", "general", "industry"]) {
    if (lowered.startsWith(d)) {
      return cleaned.slice(d.length).replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, "");
    }
  }
  return cleaned;
}

function stripTickerParentheticals(text: string): string {
  return text.replace(/\((?:[A-Z]{1,5}(?:\s*,\s*[A-Z]{1,5})*)\)/g, " ");
}

// ── CompanyResolver (mirror peer_extractor.py:130-291) ───────────────

interface ResolverEntry {
  company_id: string;
  company_name: string;
  ticker: string | null;
  cik: string | null;
  aliases: { normalized: string; display: string; confidence: number }[];
}

interface ResolvedMember {
  company_name_raw: string;
  company_id_resolved: string | null;
  company_name_resolved: string | null;
  ticker_resolved: string | null;
  cik_resolved: string | null;
  resolution_confidence: number | null;
}

function stripSuffixes(companyName: string): string | null {
  const tokens = tokenizeName(companyName);
  while (tokens.length > 0 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

function shortName(companyName: string): string | null {
  const tokens = tokenizeName(companyName);
  if (tokens.length === 2 && SHORT_NAME_SUFFIXES.has(tokens[1].toLowerCase())) {
    return tokens[0];
  }
  if (tokens.length >= 2 && tokens[tokens.length - 1].toLowerCase() === "group") {
    return tokens.slice(0, -1).join(" ");
  }
  return null;
}

function initialism(companyName: string): string | null {
  const tokens = tokenizeName(companyName).filter(
    (t) => /^[A-Za-z]+$/.test(t) && !CORPORATE_SUFFIXES.has(t.toLowerCase()),
  );
  if (tokens.length < 3) return null;
  const ini = tokens.map((t) => t[0]).join("").toUpperCase();
  if (ini.length >= 3 && ini.length <= 5) return ini;
  return null;
}

function significantTokens(companyName: string): string[] {
  return normalizeName(companyName)
    .split(" ")
    .filter((t) => t.length > 4 && !COMMON_NAME_WORDS.has(t));
}

function aliasesForName(companyName: string): { normalized: string; display: string; confidence: number }[] {
  const normalized = normalizeName(companyName);
  if (!normalized) return [];
  const candidates: { normalized: string; display: string; confidence: number }[] = [];
  const seen = new Set<string>();
  const add = (alias: string, display: string, confidence: number) => {
    const n = normalizeName(alias);
    if (!n || seen.has(n) || (n.length < 3 && !allowShortAlias(n))) return;
    seen.add(n);
    candidates.push({ normalized: n, display: display.trim(), confidence });
  };
  add(companyName, companyName, 0.99);
  const stripped = stripSuffixes(companyName);
  if (stripped && stripped !== companyName) add(stripped, stripped, 0.96);
  const sn = shortName(stripped ?? companyName);
  if (sn && sn !== companyName && sn !== stripped) add(sn, sn, 0.92);
  const ini = initialism(stripped ?? companyName);
  if (ini && ini !== companyName && ini !== stripped && ini !== sn) add(ini, ini, 0.88);
  const sigs = significantTokens(stripped ?? companyName);
  if (sigs.length === 1) add(sigs[0], sigs[0], 0.9);
  else if (sigs.length >= 2 && sigs[0].length > 4) add(sigs[0], sigs[0], 0.87);
  candidates.sort((a, b) => {
    if (a.normalized.length !== b.normalized.length) return b.normalized.length - a.normalized.length;
    return b.confidence - a.confidence;
  });
  return candidates;
}

let RESOLVER_ENTRIES: ResolverEntry[] | null = null;

function buildResolverEntries(): ResolverEntry[] {
  if (RESOLVER_ENTRIES) return RESOLVER_ENTRIES;
  const map = loadTickerMap();
  const entries: ResolverEntry[] = [];
  for (const payload of Object.values(map)) {
    const companyName = String(payload.title ?? payload.name ?? "").trim();
    const ticker = String(payload.ticker ?? "").trim() || null;
    const cikRaw = payload.cik_str ?? payload.cik;
    const cik = cikRaw !== undefined && cikRaw !== null ? String(cikRaw).padStart(10, "0") : null;
    if (!companyName) continue;
    const aliases = aliasesForName(companyName);
    if (aliases.length === 0) continue;
    const company_id = ticker ? ticker.toLowerCase() : (cik ?? companyName.toLowerCase());
    entries.push({ company_id, company_name: companyName, ticker, cik, aliases });
  }
  RESOLVER_ENTRIES = entries;
  return entries;
}

function findCompanies(text: string): ResolvedMember[] {
  const normalizedText = normalizeName(stripTickerParentheticals(text));
  if (!normalizedText) return [];
  const entries = buildResolverEntries();
  const matches: { start: number; end: number; alias: string; display: string; confidence: number; entry: ResolverEntry }[] = [];
  for (const entry of entries) {
    for (const { normalized: alias, display, confidence } of entry.aliases) {
      const start = findAlias(normalizedText, alias);
      if (start === -1) continue;
      matches.push({ start, end: start + alias.length, alias, display, confidence, entry });
      break;
    }
  }
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.confidence - a.confidence;
  });
  const selected: ResolvedMember[] = [];
  const occupied: { start: number; end: number }[] = [];
  const seenCompanyIds = new Set<string>();
  for (const m of matches) {
    if (seenCompanyIds.has(m.entry.company_id)) continue;
    if (occupied.some((r) => m.start < r.end && m.end > r.start)) continue;
    occupied.push({ start: m.start, end: m.end });
    seenCompanyIds.add(m.entry.company_id);
    selected.push({
      company_name_raw: m.display,
      company_id_resolved: m.entry.company_id,
      company_name_resolved: m.entry.company_name,
      ticker_resolved: m.entry.ticker,
      cik_resolved: m.entry.cik,
      resolution_confidence: m.confidence,
    });
  }
  return selected;
}

// ── Block-level extraction (mirror peer_extractor.py:293-606) ────────

interface ExtractedGroup {
  peer_group_name: string;
  peer_group_type: string | null;
  disclosed_year: number | null;
  selection_rationale: string | null;
  source_excerpt: string;
  confidence_score: number;
  members: ResolvedMember[];
}

function peerGroupName(year: number | null, peerGroupType: string | null): string {
  const prefix = year !== null ? `${year} ` : "";
  if (peerGroupType === null) return `${prefix}Peer Group`;
  const titleCased = peerGroupType.charAt(0).toUpperCase() + peerGroupType.slice(1);
  return `${prefix}${titleCased} Peer Group`;
}

function extractYear(yearText: string | null | undefined, blocks: string[], index: number): number | null {
  if (yearText) return Number.parseInt(yearText, 10);
  for (const ci of [index, index - 1, index + 1, index - 2, index + 2, index - 3, index + 3]) {
    if (ci < 0 || ci >= blocks.length) continue;
    const m = /\b(20\d{2})\b/.exec(blocks[ci]);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

function sourceExcerpt(blocks: string[], index: number, usedFollowingBlocks: number): string {
  const parts: string[] = [compact(blocks[index])];
  for (let offset = 1; offset <= usedFollowingBlocks; offset++) {
    const ni = index + offset;
    if (ni >= blocks.length) break;
    parts.push(compact(blocks[ni]));
  }
  return parts.filter(Boolean).join(" ").slice(0, 2000);
}

function selectionRationale(blocks: string[], index: number, peerGroupType: string | null): string | null {
  for (const ci of [index - 1, index - 2, index - 3, index - 4]) {
    if (ci < 0) continue;
    const candidate = compact(blocks[ci]);
    const lowered = candidate.toLowerCase();
    if (!matchesPeerGroupReference(lowered, peerGroupType)) continue;
    if (RATIONALE_HINTS.some((h) => lowered.includes(h))) return candidate.slice(0, 600);
  }
  return null;
}

function narrativeRationale(block: string, peerGroupType: string | null): string | null {
  const c = compact(block);
  const lowered = c.toLowerCase();
  if (!matchesPeerGroupReference(lowered, peerGroupType)) return null;
  for (const h of RATIONALE_HINTS) {
    if (lowered.includes(h)) return c.slice(0, 600);
  }
  return null;
}

function collectMembersFromText(
  blocks: string[],
  index: number,
  seedText: string,
  minMembers = 3,
  maxFollowingBlocks = 4,
): { candidateText: string; members: ResolvedMember[]; usedFollowingBlocks: number } {
  let candidateText = stripLeadingDescriptor(seedText);
  let members = findCompanies(candidateText);
  let usedFollowingBlocks = 0;
  while (members.length < minMembers && usedFollowingBlocks < maxFollowingBlocks) {
    const ni = index + usedFollowingBlocks + 1;
    if (ni >= blocks.length) break;
    const nextBlock = compact(blocks[ni]);
    if (!nextBlock) {
      usedFollowingBlocks += 1;
      continue;
    }
    candidateText = stripLeadingDescriptor(`${candidateText} ${nextBlock}`.trim());
    members = findCompanies(candidateText);
    usedFollowingBlocks += 1;
  }
  return { candidateText, members, usedFollowingBlocks };
}

function collectMembersFromFollowingBlocks(
  blocks: string[],
  index: number,
  minMembers = 5,
  maxFollowingBlocks = 4,
): { candidateText: string; members: ResolvedMember[]; usedFollowingBlocks: number } {
  let candidateText = "";
  let members: ResolvedMember[] = [];
  let usedFollowingBlocks = 0;
  while (members.length < minMembers && usedFollowingBlocks < maxFollowingBlocks) {
    const ni = index + usedFollowingBlocks + 1;
    if (ni >= blocks.length) break;
    const nextBlock = compact(blocks[ni]);
    if (!nextBlock) {
      usedFollowingBlocks += 1;
      continue;
    }
    candidateText = `${candidateText} ${nextBlock}`.trim();
    members = findCompanies(candidateText);
    usedFollowingBlocks += 1;
  }
  return { candidateText, members, usedFollowingBlocks };
}

function extractFromHeadedBlock(blocks: string[], index: number, compactBlock: string): ExtractedGroup | null {
  const m = HEADED_GROUP_PATTERN.exec(compactBlock);
  if (m === null || m.index !== 0) return null;
  let membersText = compactBlock.slice(m.index + m[0].length).replace(/^[\s:\-]+|[\s:\-]+$/g, "");
  membersText = stripLeadingDescriptor(membersText);
  if (looksLikeRationaleText(membersText)) return null;
  const collected = collectMembersFromText(blocks, index, membersText);
  if (collected.members.length < 3) return null;
  const year = extractYear(m.groups?.year ?? null, blocks, index);
  let peerGroupType = m.groups?.kind ? m.groups.kind.toLowerCase() : null;
  if (peerGroupType === null) {
    const lowered = compactBlock.toLowerCase();
    if (year === null || collected.members.length < 5) return null;
    if (["index", "tsr", "modifier", "used for", "analysis"].some((t) => lowered.includes(t))) return null;
  }
  const groupName = peerGroupName(year, peerGroupType);
  const rationale = selectionRationale(blocks, index, peerGroupType);
  let excerpt = sourceExcerpt(blocks, index, collected.usedFollowingBlocks);
  if (excerpt.length < 360 && index > 0) {
    const prev = compact(blocks[index - 1]);
    if (prev.toLowerCase().includes("peer group")) {
      excerpt = `${prev} ${excerpt}`;
    }
  }
  return {
    peer_group_name: groupName,
    peer_group_type: peerGroupType,
    disclosed_year: year,
    selection_rationale: rationale,
    source_excerpt: excerpt.slice(0, 2000),
    confidence_score: 0.98,
    members: collected.members,
  };
}

function extractFromIncludedBlock(blocks: string[], index: number, compactBlock: string): ExtractedGroup | null {
  let m = INCLUDED_GROUP_PATTERN.exec(compactBlock);
  let peerGroupType: string | null;
  let yearText: string | null | undefined;
  let body: string;
  if (m === null) {
    const ref = GROUP_REFERENCE_PATTERN.exec(compactBlock);
    const tgi = THIS_GROUP_INCLUDED_PATTERN.exec(compactBlock);
    if (ref === null || tgi === null) return null;
    if (tgi.index <= ref.index) return null;
    peerGroupType = ref.groups?.kind ? ref.groups.kind.toLowerCase() : null;
    yearText = ref.groups?.year;
    body = tgi.groups?.body ?? "";
  } else {
    peerGroupType = m.groups?.kind ? m.groups.kind.toLowerCase() : null;
    yearText = m.groups?.year;
    body = m.groups?.body ?? "";
  }
  const members = findCompanies(body);
  if (members.length < 3) return null;
  const year = extractYear(yearText ?? null, blocks, index);
  const rationale = narrativeRationale(compactBlock, peerGroupType);
  return {
    peer_group_name: peerGroupName(year, peerGroupType),
    peer_group_type: peerGroupType,
    disclosed_year: year,
    selection_rationale: rationale,
    source_excerpt: compactBlock.slice(0, 2000),
    confidence_score: 0.91,
    members,
  };
}

function extractFromPeerCompanyBlock(blocks: string[], index: number, compactBlock: string): ExtractedGroup | null {
  const selected = SELECTED_PEER_COMPANIES_PATTERN.exec(compactBlock);
  if (selected !== null) {
    const collected = collectMembersFromText(blocks, index, selected.groups?.body ?? "");
    if (collected.members.length >= 3) {
      const year = Number.parseInt(selected.groups?.year ?? "0", 10);
      return {
        peer_group_name: peerGroupName(year, null),
        peer_group_type: null,
        disclosed_year: year,
        selection_rationale: compactBlock.slice(0, 600),
        source_excerpt: sourceExcerpt(blocks, index, collected.usedFollowingBlocks),
        confidence_score: 0.93,
        members: collected.members,
      };
    }
  }

  const approvedBelow = APPROVED_BELOW_PEER_GROUP_PATTERN.exec(compactBlock);
  if (approvedBelow !== null) {
    const collected = collectMembersFromText(blocks, index, approvedBelow.groups?.body ?? "", 5, 0);
    if (collected.members.length >= 5) {
      const year = Number.parseInt(approvedBelow.groups?.year ?? "0", 10);
      return {
        peer_group_name: peerGroupName(year, null),
        peer_group_type: null,
        disclosed_year: year,
        selection_rationale: compactBlock.slice(0, 600),
        source_excerpt: compactBlock.slice(0, 2000),
        confidence_score: 0.95,
        members: collected.members,
      };
    }
  }

  const consisted = COMPENSATION_PEER_GROUP_LIST_PATTERN.exec(compactBlock);
  if (consisted !== null) {
    const collected = collectMembersFromText(blocks, index, consisted.groups?.body ?? "");
    if (collected.members.length >= 3) {
      const year = Number.parseInt(consisted.groups?.year ?? "0", 10);
      return {
        peer_group_name: peerGroupName(year, null),
        peer_group_type: null,
        disclosed_year: year,
        selection_rationale: compactBlock.slice(0, 600),
        source_excerpt: sourceExcerpt(blocks, index, collected.usedFollowingBlocks),
        confidence_score: 0.94,
        members: collected.members,
      };
    }
  }

  const approved = APPROVED_PEER_COMPANIES_PATTERN.exec(compactBlock);
  if (approved === null) return null;
  const collected = collectMembersFromFollowingBlocks(blocks, index, 5);
  if (collected.members.length < 5) return null;
  const year = Number.parseInt(approved.groups?.year ?? "0", 10);
  return {
    peer_group_name: peerGroupName(year, null),
    peer_group_type: null,
    disclosed_year: year,
    selection_rationale: compactBlock.slice(0, 600),
    source_excerpt: sourceExcerpt(blocks, index, collected.usedFollowingBlocks),
    confidence_score: 0.92,
    members: collected.members,
  };
}

function stamp() {
  return {
    extractor_version: PEER_EXTRACTOR_VERSION,
    extraction_method: "block-anchor",
    source_document_name: null,
    source_document_sha: null,
    verification_status: "machine_extracted" as const,
    review_status: "unreviewed" as const,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
  };
}

export function extractPeerGroups(
  filingId: string,
  cdaText: string,
): Omit<PeerGroupRow, "id" | "section_id">[] {
  const blocks = cdaText.split("\n\n").map((b) => b.trim()).filter(Boolean);
  const extracted: ExtractedGroup[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const c = compact(blocks[i]);
    let group = extractFromHeadedBlock(blocks, i, c);
    if (group === null) group = extractFromIncludedBlock(blocks, i, c);
    if (group === null) group = extractFromPeerCompanyBlock(blocks, i, c);
    if (group === null || group.members.length === 0) continue;

    const memberKey = group.members
      .map((m) => m.company_id_resolved ?? m.company_name_raw)
      .join("|");
    const dedupeKey = `${group.peer_group_name.toLowerCase()}::${group.disclosed_year ?? "null"}::${memberKey}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    extracted.push(group);
  }

  return extracted.map((g) => ({
    filing_id: filingId,
    peer_group_name: g.peer_group_name,
    peer_group_type: g.peer_group_type,
    disclosed_year: g.disclosed_year,
    selection_rationale: g.selection_rationale,
    source_excerpt: g.source_excerpt,
    confidence_score: g.confidence_score,
    members: g.members.map(
      (m) =>
        ({
          company_name_raw: m.company_name_raw,
          company_id_resolved: m.company_id_resolved,
          company_name_resolved: m.company_name_resolved,
          ticker_resolved: m.ticker_resolved,
          cik_resolved: m.cik_resolved,
          resolution_confidence: m.resolution_confidence,
        }) as PeerGroupMemberRow,
    ),
    ...stamp(),
  }));
}

export function resolveCompanyName(rawName: string): {
  resolved_name: string | null;
  ticker: string | null;
  cik: string | null;
  company_id: string | null;
  confidence: number;
} {
  const matches = findCompanies(rawName);
  if (matches.length === 0) {
    return { resolved_name: null, ticker: null, cik: null, company_id: null, confidence: 0 };
  }
  const m = matches[0];
  return {
    resolved_name: m.company_name_resolved,
    ticker: m.ticker_resolved,
    cik: m.cik_resolved,
    company_id: m.company_id_resolved,
    confidence: m.resolution_confidence ?? 0,
  };
}
