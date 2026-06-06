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

import * as cheerio from "cheerio";

import type { PeerGroupRow, PeerGroupMemberRow } from "@/lib/types";

export const PEER_EXTRACTOR_VERSION = "peer_extractor.ts.v1";

// ── Block patterns (mirror peer_extractor.py:10-49) ──────────────────

// `peer group(?=\b|[A-Z])` lets the heading match even when an HTML
// table/heading lost its trailing whitespace and the first company
// name is glued on: cheerio's `.text()` on `<h3>Peer Group</h3><table>
// <tr><td>Alphabet</td>...` produces "Peer GroupAlphabet" — META
// emits the heading exactly this way. The lookahead allows the
// uppercase letter that starts the first member name to act as a
// non-zero-width word boundary.
//
// The optional `<modifier>` qualifier captures company-specific
// labels (Retail, Compensation, Industry, etc.) so e.g. Home Depot's
// "Retail Peer Group" and Disney's "General Industry Peer Group"
// are recognized as headed blocks.
const HEADED_GROUP_PATTERN =
  /(?:(?:our|the|its|executive)\s+)?(?:(?:fiscal|calendar)\s+)?(?:(?<year>20\d{2})\s+)?(?:(?<kind>primary|secondary)\s+)?(?:(?<modifier>compensation|retail|industry|comparator|comparison|performance|media|tsr|general(?:\s+industry)?|executive\s+compensation)\s+)?peer\s+group(?=\b|[A-Z])/i;
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
// Danaher-shape: "[The|Our|Company's] peer group (parenthetical
// optional) consisted of the companies set forth below". List is in
// a following block. The parenthetical may carry the year.
const PEER_GROUP_CONSISTED_OF_PATTERN =
  /(?<prefix>(?:the\s+|our\s+|company['’]s\s+)?peer\s+group(?:\s+\([^)]{0,400}?\))?\s+consisted\s+of\s+the\s+companies\s+set\s+forth\s+below)\s*[:.\s]?\s*(?<body>.*)$/i;
// Costco-shape: "For fiscal YYYY, the Committee primarily considered
// executive compensation data obtained from proxy statements for the
// following peer companies: ...". The list is inline after the colon.
const CONSIDERED_FOR_FOLLOWING_PATTERN =
  /(?<prefix>for\s+(?:fiscal\s+)?(?<year>20\d{2}),?\s+[^.]{0,200}?\s+for\s+the\s+following\s+peer\s+companies)\s*:?\s*(?<body>.+)$/i;
// Fifth Third-shape: "The following N companies were identified by
// the Committee as our Compensation Peer Group for YYYY ('Compensation
// Peer Group')". The actual list is in the immediately following
// block.
const FOLLOWING_N_COMPANIES_PATTERN =
  /(?<prefix>the\s+following\s+\d{1,3}\s+companies\s+were\s+identified\s+by\s+[^.]{0,200}?\s+as\s+(?:our\s+|the\s+)?(?:[A-Z][a-zA-Z]+\s+)?peer\s+group(?:\s+for\s+(?<year>20\d{2}))?)/i;

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
  // Corporate suffixes (also in CORPORATE_SUFFIXES — duplicated here
  // for the significantTokens filter).
  "group", "holdings", "holding", "company", "companies",
  "corp", "corporation", "inc", "co", "plc", "ltd",
  // Common business descriptors that show up as significant tokens in
  // many filer names ("Bath & Body Works" → "works", "T-Mobile" →
  // "mobile") and would otherwise create single-token aliases that
  // match generic English prose anywhere in a CD&A. Each entry was
  // verified against a peer-extraction probe of the live cohort.
  "works", "market", "markets", "marketplace",
  "network", "networks", "networking",
  "industries", "industry",
  "service", "services",
  "system", "systems",
  "technology", "technologies",
  "media", "energy", "power",
  "brands", "brand", "partners", "partnership",
  "acquisition", "acquisitions",
  "communications", "communication",
  "products", "product",
  "platforms", "platform",
  "solutions", "solution",
  "resources", "resource",
  "properties", "property",
  "capital", "financial", "finance",
  "hospitality", "hotels", "hotel",
  "growth", "value",
  "sciences", "science",
  "dynamics", "instruments", "materials",
  "electric", "electronic", "electronics",
  "software", "hardware",
  "mobile", "motors",
  "foods", "food", "beverages", "beverage",
  "automotive", "auto", "autos",
  "banks", "bank", "bancshares", "bancorp",
  "airlines", "airline",
  "trust", "trusts", "trustco",
  "international", "global", "national",
  "first", "premier", "consolidated", "general",
  "american", "european", "asian", "atlantic", "pacific",
  "natural", "industrial", "commercial", "residential",
  "stores", "store", "retail",
  "transport", "transports", "transportation",
  "construction", "logistics", "supply",
  "health", "healthcare", "medical",
  "studios", "studio", "entertainment",
  "express", "direct", "online",
  // Generic equipment / engineering / industrial single tokens — AYI
  // probe showed these false-matching prose words like "equipment".
  "equipment", "equipments",
  "engineering", "engineered",
  "manufacturing", "manufactured",
  "production", "operations",
  "smith", "wesson", "jones", "smith's",
  // Short surnames + product categories that show up in multi-token
  // company titles ("Smith Micro", "Jones Lang LaSalle").
  "micro", "macro",
  "global", "americas",
  "northern", "southern", "western", "eastern",
  "petroleum", "chemical", "chemicals", "mining",
  "agriculture", "agricultural", "farms",
  "tobacco", "alcohol",
  "container", "containers", "packaging",
  "wholesale", "stores",
  // Phase 11 expansion: single-token aliases observed resolving to
  // bogus tickers in production probes of SPG / INTC / KEY / DXCM.
  // Each was a common English/business word appearing in CD&A prose
  // that latched onto an unrelated SEC company name. Examples:
  //   "below" → FIVE (Five Below, Inc.)
  //   "above" → ABVE (Above Food Ingredients Inc.)
  //   "tower" → AMT (American Tower Corp)
  //   "estate" → CMRF (Coatue Mining Resources Fund)
  //   "castle" → CSTL (Castle Biosciences)
  //   "realty" → matches Realty Income on bare prose
  //   "investment(s)" → AGNC / SEIC
  //   "payments" → GPN (Global Payments)
  //   "regional" → bogus regional-bank match
  //   "performance" → PFGC (Performance Food Group)
  //   "institutions" → FISI (Financial Institutions Inc)
  //   "focus" → EFOI / Focus Financial
  //   "universal" → UHS (Universal Health Services)
  //   "leaders" → GLCP
  //   "business" → BFST
  //   "strategic" → ARSMF
  //   "greater" → GCAN (Greater Cannabis)
  //   "match"   → MTCH (Match Group)
  //   "perfect" → PERF (Perfect Corp)
  //   "pool"    → POOL (Pool Corp)
  //   "discovery" → DISCA / DISCK / WBD prose hits
  //   "twelve"  → SPAC vehicles named "Twelve …"
  //   "range"   → RRC (Range Resources)
  //   "times"   → NYT (New York Times)
  //   "wave"    → WVE (Wave Life Sciences)
  //   "ingredients" → ABVE
  //   "pharmaceutical" → CTTH / generic pharma matches
  // Full multi-word aliases of these companies still resolve correctly
  // (e.g. "Five Below" → FIVE), but their bare-token aliases are
  // suppressed so generic prose can't trigger them.
  "above", "below", "beyond",
  "strategic", "tactical", "operational",
  "investment", "investments", "investor", "investors",
  "payment", "payments",
  "performance", "performing",
  "regional",
  "institution", "institutions", "institutional",
  "universal",
  "business", "businesses",
  "focus", "focused",
  "leader", "leaders", "leading",
  "tower", "towers",
  "estate", "estates", "realty",
  "castle",
  "discovery",
  "ingredient", "ingredients",
  "pharmaceutical", "pharmaceuticals",
  "match", "matches",
  "perfect",
  "pool", "pools",
  "twelve",
  "range", "ranges",
  "times",
  "wave", "waves",
  "greater", "lesser",
  "diagnostic", "diagnostics",
  "biosciences", "bioscience", "biotech",
  "digital",
  "analytics", "analysis",
  "enterprise", "enterprises",
  "venture", "ventures",
  // Second-pass additions after observing residual SPG / INTC false
  // positives ("income" → Realty Income, "ebay" → eBay verb usage,
  // "gap" → both an English word and Gap Inc, "centers" → Saul
  // Centers, "street" → Main Street Capital, "information" → CASS,
  // "devices" → MASS, "gps" → Guardian Pharmacy via initialism).
  "ebay", "gap", "gps", "cci", "reg",
  "income", "incomes",
  "center", "centers",
  "street", "streets",
  "information", "informational",
  "device", "devices",
  "main", "primary",
  "select", "selected",
  "stable", "stability",
  // Third-pass additions after observing post-reingest residual false
  // positives in cohort sweep:
  //   "table"       → TBTC (Table Trac Inc) — "Summary Compensation Table" prose
  //   "total"       → STEW (SRH Total Return Fund)
  //   "equity"      → EQR (Equity Residential) — "equity" appears constantly in proxies
  //   "short"       → SDHY (Short Duration High Yield Fund)
  //   "paid"        → PAYD (Paid Inc) — past-tense English verb
  //   "light"       → OHCFF (Light AI Inc)
  //   "engagement"  → BNAI ("stockholder engagement" prose)
  //   "versus"      → VS (Versus Systems Inc)
  //   "trading"     → HEPS (D-MARKET Electronic Services & Trading)
  //   "relevant"    → RGCCF (Relevant Gold Corp)
  //   "laboratories" → BIO (Bio-Rad Laboratories) — generic in pharma proxies
  //   "beyond"      → BYND (Beyond Meat) — common preposition
  //   "alignment"   → ALHC ("alignment of pay and performance" prose)
  //   "benchmark"   → BHE / BMRK
  //   "various"     → VARI
  //   "alternative" → AAII / ALT
  "table", "tables",
  "total", "totals",
  "equity", "equities", "equitable",
  "short", "shorter", "shortest",
  "paid", "unpaid",
  "light", "lights", "lighting",
  "engagement", "engagements", "engaged",
  "versus",
  "trading", "traders", "trader",
  "relevant", "relevance",
  "laboratory", "laboratories",
  "beyond",
  "alignment", "aligned",
  "benchmark", "benchmarks", "benchmarking",
  "various", "variety",
  "alternative", "alternatives",
  "biotech", "biotechnology",
  "mineral", "minerals", "mining",
  "gold", "silver", "copper",
  "report", "reports", "reporting",
  // Fourth-pass additions after Phase 15 cohort expansion surfaced
  // residuals in newly-ingested ticker panels (a/axp/mrk/tmus):
  //   "independent"  → INDB (Independent Bank Corp) — survives 6-char
  //                    cutoff (11 chars), constant in proxy prose
  //                    ("independent committee", "independent directors")
  //   "effective"    → SFWJ (Software Effective Solutions)
  //   "consumer"     → PMVC, "consulting" → FCN
  //   "opportunities" → KIO (KKR Income Opportunities Fund)
  //   "limited"      → EBOSY adjacency
  "independent", "independently",
  "effective", "effectively",
  "consumer", "consumers", "consumption",
  "consulting", "consultant", "consultants",
  "opportunity", "opportunities",
  "limited",  // also a corporate suffix; defensive
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
  const cleaned = text.replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, "");
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
  // Popping "Co"/"Inc" off an "X & Co., Inc." name leaves a dangling
  // ampersand ("Merck & Co., Inc." → ["Merck", "&"]). Left in, the
  // stripped alias normalizes to "merck and", which never matches the
  // bare "Merck" a proxy peer list actually prints. Drop the trailing
  // conjunction so the short alias is the real company token.
  while (
    tokens.length > 0 &&
    (tokens[tokens.length - 1] === "&" ||
      tokens[tokens.length - 1].toLowerCase() === "and")
  ) {
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
  /** Block single-token aliases that are common English/business words.
   * Multi-word aliases pass through unchanged here; the risk is only
   * when a one-word alias would match generic prose ("works", "market"
   * etc). The full-name + stripped-name aliases already handle the
   * disambiguated case ("Bath & Body Works, Inc." → "bath and body works"). */
  const isBlocklistedSingleToken = (n: string) => {
    if (n.includes(" ")) return false;
    return COMMON_NAME_WORDS.has(n);
  };
  /** Block multi-word aliases whose every token is in COMMON_NAME_WORDS.
   * The stripped-name path can produce phrases like "financial
   * institutions" (FISI), "global payments" (GPN), or "performance
   * food" (PFGC) that look like real proxy peer mentions but are also
   * common English noun phrases ("financial institutions in our
   * benchmark group"). When every token is blocklisted, the alias is
   * effectively unanchored to a specific company. Companies that need
   * to be matched in proxy text via these phrases must do so through
   * the full-name-with-suffix alias (e.g. "financial institutions inc")
   * which is rarer in prose. */
  const isBlocklistedMultiWord = (n: string) => {
    const tokens = n.split(" ");
    if (tokens.length < 2) return false;
    return tokens.every((t) => COMMON_NAME_WORDS.has(t));
  };
  const add = (alias: string, display: string, confidence: number) => {
    const n = normalizeName(alias);
    if (!n || seen.has(n) || (n.length < 3 && !allowShortAlias(n))) return;
    if (isBlocklistedSingleToken(n)) return;
    if (isBlocklistedMultiWord(n)) return;
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
  // Single-token aliases from the significant-token path are the
  // dominant source of false positives — generic English words >4
  // chars in a multi-word company name (e.g. "Below" from "Five
  // Below, Inc.") match unrelated CD&A prose. Require length ≥ 6 for
  // the single-significant-token case and ≥ 7 for the first-of-many
  // case so common 5-char English words ("below", "table", "short")
  // cannot create a single-token alias. Companies whose stripped name
  // is a real proper noun (Apple, Tesla, Adobe, Cisco) still get
  // matched via the stripSuffixes / shortName paths above.
  const sigs = significantTokens(stripped ?? companyName);
  if (sigs.length === 1 && sigs[0].length >= 6) add(sigs[0], sigs[0], 0.9);
  else if (sigs.length >= 2 && sigs[0].length >= 7) add(sigs[0], sigs[0], 0.87);
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
  // Title-case each underscore-separated token: "general_industry" →
  // "General Industry"; "primary" → "Primary". Underscores arise when
  // a multi-word modifier (e.g. "General Industry") is captured.
  const titleCased = peerGroupType
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
  // Prefer the explicit primary/secondary kind. Otherwise fall back to
  // the modifier (retail/compensation/industry/etc.) as a soft
  // classification so the safety check below treats this as a real
  // labeled peer group rather than an ambiguous "Peer Group" heading.
  const kindFromExplicit = m.groups?.kind?.toLowerCase() ?? null;
  const kindFromModifier = m.groups?.modifier?.toLowerCase().replace(/\s+/g, "_") ?? null;
  const peerGroupType = kindFromExplicit ?? kindFromModifier ?? null;
  if (peerGroupType === null) {
    const lowered = compactBlock.toLowerCase();
    // Tightened from ≥5 to ≥7. Real disclosed peer groups are
    // typically ≥10 companies (Item 402(b) practice); a 4-6 member
    // match with no kind/modifier is almost always noise from
    // findCompanies resolving incidental company-name tokens.
    if (year === null || collected.members.length < 7) return null;
    if (["index", "modifier", "used for", "analysis"].some((t) => lowered.includes(t))) return null;
  }
  // Quality guard for "modifier-only" matches (Retail/Compensation/
  // Industry/General Industry/etc. — not the canonical primary/
  // secondary kinds): require ≥7 members. Same rationale as the
  // null-peerGroupType branch above. Without this guard the broader
  // modifier vocab introduced in Phase F1 produces 4-6 member false
  // positives (e.g. DIS "2026 General Industry Peer Group" pulling
  // GE/Structure Therapeutics/PPG/Gray Media from inline noise).
  if (kindFromExplicit === null && kindFromModifier !== null
      && collected.members.length < 7) {
    return null;
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
  const m = INCLUDED_GROUP_PATTERN.exec(compactBlock);
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

  const consistedOf = PEER_GROUP_CONSISTED_OF_PATTERN.exec(compactBlock);
  if (consistedOf !== null) {
    const collected = collectMembersFromText(blocks, index, consistedOf.groups?.body ?? "");
    if (collected.members.length >= 3) {
      const year = extractYear(null, blocks, index);
      return {
        peer_group_name: peerGroupName(year, "compensation"),
        peer_group_type: "compensation",
        disclosed_year: year,
        selection_rationale: compactBlock.slice(0, 600),
        source_excerpt: sourceExcerpt(blocks, index, collected.usedFollowingBlocks),
        confidence_score: 0.92,
        members: collected.members,
      };
    }
  }

  const consideredFollowing = CONSIDERED_FOR_FOLLOWING_PATTERN.exec(compactBlock);
  if (consideredFollowing !== null) {
    const collected = collectMembersFromText(blocks, index, consideredFollowing.groups?.body ?? "");
    if (collected.members.length >= 3) {
      const year = Number.parseInt(consideredFollowing.groups?.year ?? "0", 10);
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
  }

  const followingN = FOLLOWING_N_COMPANIES_PATTERN.exec(compactBlock);
  if (followingN !== null) {
    // Members are in the next block; use the empty body and let
    // collectMembersFromText pull subsequent blocks.
    const collected = collectMembersFromText(blocks, index, "");
    if (collected.members.length >= 3) {
      const year = extractYear(followingN.groups?.year ?? null, blocks, index);
      return {
        peer_group_name: peerGroupName(year, "compensation"),
        peer_group_type: "compensation",
        disclosed_year: year,
        selection_rationale: compactBlock.slice(0, 600),
        source_excerpt: sourceExcerpt(blocks, index, collected.usedFollowingBlocks),
        confidence_score: 0.92,
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

  // Defensive post-extraction quality guard: reject members whose
  // `company_name_raw` is itself in the COMMON_NAME_WORDS blocklist.
  // The blocklist is checked at alias-build time so this is mostly
  // belt-and-suspenders, but if a future change accidentally lets a
  // blocked alias back into the index (or someone adds a new common
  // word to the blocklist without rebuilding), the guard ensures the
  // member never lands in the output.
  //
  // Important: do NOT reject by "single lowercase token" — legitimate
  // SEC titles like "COSTCO WHOLESALE CORP /NEW" produce significant
  // tokens like "costco" (lowercase in the alias index for matching),
  // and their resolved `company_name_raw` carries that lowercase form.
  // The blocklist gives a precise reject signal; case is incidental.
  function isBlocklistedNoise(raw: string): boolean {
    if (!raw) return true;
    const lower = raw.toLowerCase().trim();
    if (lower.includes(" ")) return false;     // multi-word → keep
    return COMMON_NAME_WORDS.has(lower);
  }

  return extracted
    .map((g) => ({
      ...g,
      members: g.members.filter((m) => !isBlocklistedNoise(m.company_name_raw)),
    }))
    .filter((g) => g.members.length > 0)
    .map((g) => ({
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

// ── HTML-table peer extractor ─────────────────────────────────────────
//
// Many filers (HUBB, MA, WMT, and others) emit the peer-company list
// as a 3-column or 4-column HTML table immediately after a heading
// like "Compensation Peer Group" / "Peer Companies" / "Compensation
// Peer Companies". The CD&A-only text extractor misses these because
// the company names live inside `<td>` cells with no enumerating
// preamble in the surrounding paragraphs.
//
// This extractor scans for peer-group-style headings, walks to the
// next sibling table (or table inside the next sibling), reads every
// cell, and keeps cells that look like corporate names (carry a
// corporate suffix or are a recognizable single-word company). It
// only emits a group when ≥7 recognized companies are found —
// matching the Phase F1 quality guard used by the text extractor.
//
// Source HTML lives in the same `html` string the SCT extractor
// consumes; the caller invokes this alongside the text extractor and
// the union of results lands in the database.

const HTML_PEER_HEADING_PATTERN =
  /^(?:(?:our|the|2024|2025|2026|fiscal\s+20\d{2})\s+)?(?:(?:compensation|retail|industry|comparator|comparison|primary|secondary|executive\s+compensation|general\s+industry|media|tsr)\s+)?peer\s+(?:group|companies|company)(?:\s+for\s+(?:fiscal\s+)?20\d{2})?(?:\s*[-–—:].*)?$/i;

// A cell is "company-like" if it carries a corporate suffix or
// matches one of the known short single-word names. Mirrors the
// `CORPORATE_SUFFIXES` set already used by the text extractor, but
// applied per-cell rather than as inline tokens.
const CORPORATE_SUFFIX_RE =
  /\b(?:Inc\.?|Incorporated|Corp\.?|Corporation|Company|Co\.?|LLC|Ltd\.?|Limited|Group|plc|S\.?A\.?|Holdings|Holding|N\.?V\.?|A\.?G\.?)\b/;
const CELL_REJECT_PATTERNS: RegExp[] = [
  /^(?:Total|Sum|Average|Median|Mean|Subtotal|Sub-?total)\b/i,
  /^\(?\d/, // starts with a digit or paren-digit (numeric value)
  /^[$%]/,
  /^[-–—]+$/, // dash placeholder
  /^(?:N\/?A|TBD|TBA|—)$/i,
  // Section-header text mistakenly carries a corporate suffix
  // ("Compensation Peer Group Company"). Reject any cell whose head
  // matches a peer-group heading phrase.
  /\bpeer\s+(?:group|company|companies)\b/i,
  /\bcompensation\s+(?:peer|committee|consultant)\b/i,
];

function isPeerCompanyCell(text: string): boolean {
  if (!text || text.length > 80) return false;
  if (CELL_REJECT_PATTERNS.some((p) => p.test(text))) return false;
  if (!CORPORATE_SUFFIX_RE.test(text)) return false;
  // Reject cells where the corporate suffix IS the whole cell text —
  // e.g. PSA puts a bare "Company" as the column header. Real
  // companies always have a name word in front of the suffix.
  const stripped = text.replace(/\(.*?\)/g, "").trim();
  if (
    /^(?:Inc\.?|Incorporated|Corp\.?|Corporation|Company|Co\.?|LLC|Ltd\.?|Limited|Group|plc|Holdings|Holding)$/i.test(stripped)
  ) {
    return false;
  }
  // Must contain at least one capital-leading word that ISN'T the
  // suffix — rejects narrative fragments that happened to mention
  // "inc" and bare-header cells.
  const beforeSuffix = text
    .replace(CORPORATE_SUFFIX_RE, "")
    .replace(/[,.&'’]/g, " ")
    .trim();
  if (!/[A-Z][a-zA-Z]+/.test(beforeSuffix)) return false;
  return true;
}

function findNextPeerTable(
  $: cheerio.CheerioAPI,
  heading: import("domhandler").Element,
  orderedElements: import("domhandler").Element[],
  headingIndex: number,
): import("domhandler").Element | null {
  // Walk document-order from the heading forward. Pick the first
  // `<table>` with ≥7 company-like cells; skip narrative/criteria
  // tables that surround the peer list (e.g. HUBB has 4-5 non-peer
  // tables — "Industry Affiliation" criteria, "Changes to the Peer
  // Group" prose, etc. — before the actual peer-list grid).
  //
  // Caps at 400 forward elements (~one page of structured content)
  // to avoid drifting into the next major section.
  const limit = Math.min(orderedElements.length, headingIndex + 400);
  for (let i = headingIndex + 1; i < limit; i++) {
    const el = orderedElements[i];
    if (el.tagName !== "table") continue;
    let companyLike = 0;
    $(el)
      .find("td, th")
      .each((_, cell) => {
        const t = $(cell).text().replace(/\s+/g, " ").trim();
        if (isPeerCompanyCell(t)) companyLike++;
        return companyLike < 8;
      });
    if (companyLike >= 7) return el;
  }
  return null;
}

function collectElementsPreOrder(
  root: import("domhandler").Element | undefined,
): import("domhandler").Element[] {
  const out: import("domhandler").Element[] = [];
  if (!root) return out;
  const stack: import("domhandler").Element[] = [root];
  while (stack.length) {
    const next = stack.pop()!;
    out.push(next);
    // Push children in reverse so pre-order pops left-to-right
    const children = (next.children ?? []).filter(
      (c): c is import("domhandler").Element => c.type === "tag",
    );
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

// True when the IMMEDIATELY-PRECEDING small text bearing a heading-
// or sentence-level element mentions a peer-group concept. We scan
// at most 8 elements backward and stop at the first one whose text
// is between 5 and 200 chars (heading-shaped). Tighter than a broad
// 30-element bag because CD&A naturally mentions "Named Executive
// Officers" near peer discussion — a coarse reject filter would
// drop too many real peer tables.
const PEER_INTRO_PATTERN =
  /\b(?:compensation\s+peer\s+group|peer\s+(?:group|companies|company)|comparator\s+group|reference\s+(?:peer|group)|benchmarking\s+(?:peer|group)|competitive\s+peer|industry\s+peer|2025\s+netflix\s+peer\s+group|peer\s+companies\s+for\s+(?:fiscal\s+)?20\d{2})\b/i;
// Hard reject when the closest heading-shape text IS a non-peer
// table label. These are short and unambiguous so we can match
// them safely.
const PEER_INTRO_REJECT_PATTERN =
  /^(?:audit\s+(?:firm|fees?|matters)|director\s+(?:nominees|compensation|qualifications)|named\s+executive\s+officer(?:s|s?\s+\(NEOs?\))?|board\s+of\s+(?:directors|trustees)|share\s+ownership\s+requirements?)/i;

function precedingTextHasPeerIntro(
  $: cheerio.CheerioAPI,
  ordered: import("domhandler").Element[],
  tableIdx: number,
): boolean {
  // Look at up to 10 immediately-preceding small (heading-shape)
  // text elements. Accept on first PEER_INTRO match; reject on
  // first explicit non-peer-table heading match.
  for (let i = tableIdx - 1; i >= 0 && i >= tableIdx - 10; i--) {
    const el = ordered[i];
    if (el.tagName === "table") break;
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t || t.length < 5 || t.length > 200) continue;
    if (PEER_INTRO_REJECT_PATTERN.test(t)) return false;
    if (PEER_INTRO_PATTERN.test(t)) return true;
  }
  return false;
}

function precedingTextInfo(
  $: cheerio.CheerioAPI,
  ordered: import("domhandler").Element[],
  tableIdx: number,
): { intro: string; year: number | null; peerType: string | null } {
  const collected: string[] = [];
  for (let i = tableIdx - 1; i >= 0 && i >= tableIdx - 30; i--) {
    const el = ordered[i];
    if (el.tagName === "table") break;
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t || t.length > 400 || collected.includes(t)) continue;
    collected.push(t);
    if (collected.join(" ").length > 1200) break;
  }
  const intro = collected.reverse().join(" ").slice(0, 600);
  const yearMatch = intro.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;
  const lowered = intro.toLowerCase();
  let peerType: string | null = null;
  if (/\bcompensation\s+peer/.test(lowered)) peerType = "compensation";
  else if (/\bretail\s+peer/.test(lowered)) peerType = "retail";
  else if (/\bindustry\s+peer/.test(lowered)) peerType = "industry";
  else if (/\bcomparator\s+group/.test(lowered)) peerType = "comparator";
  else if (/\bperformance\s+peer/.test(lowered) || /\btsr\s+peer/.test(lowered)) peerType = "performance";
  else if (/\bmedia\s+peer/.test(lowered)) peerType = "media";
  return { intro, year, peerType };
}

export function extractPeerGroupsFromHtmlTables(
  filingId: string,
  html: string,
): Omit<PeerGroupRow, "id" | "section_id">[] {
  if (!html.trim()) return [];
  const $ = cheerio.load(html);
  const groups: Omit<PeerGroupRow, "id" | "section_id">[] = [];
  const seenKeys = new Set<string>();

  const bodyEl = ($("body").get(0) ?? $.root().get(0)) as
    | import("domhandler").Element
    | undefined;
  const ordered = collectElementsPreOrder(bodyEl);
  const orderedIdx = new Map<import("domhandler").Element, number>();
  for (let i = 0; i < ordered.length; i++) orderedIdx.set(ordered[i], i);

  // Path 1: heading-led — find peer-group heading then walk forward
  // to first company-rich table.
  $("h1, h2, h3, h4, h5, b, strong, p, div, span, td").each((_, el) => {
    const text = $(el)
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 80) return;
    if (!HTML_PEER_HEADING_PATTERN.test(text)) return;

    const headingIdx = orderedIdx.get(el);
    if (headingIdx === undefined) return;
    const table = findNextPeerTable($, el, ordered, headingIdx);
    if (!table) return;

    const cells: string[] = [];
    $(table)
      .find("td, th")
      .each((_, cell) => {
        const cellText = $(cell).text().replace(/\s+/g, " ").trim();
        if (!isPeerCompanyCell(cellText)) return;
        if (cells.includes(cellText)) return;
        cells.push(cellText);
      });
    if (cells.length < 7) return;

    const members: PeerGroupMemberRow[] = cells.map((name) => {
      const r = resolveCompanyName(name);
      return {
        company_name_raw: name,
        company_id_resolved: r.company_id,
        company_name_resolved: r.resolved_name ?? name,
        ticker_resolved: r.ticker,
        cik_resolved: r.cik,
        resolution_confidence: r.confidence,
      } as PeerGroupMemberRow;
    });

    const lowered = text.toLowerCase();
    let peerType: string | null = null;
    if (/\bcompensation\b/.test(lowered)) peerType = "compensation";
    else if (/\bretail\b/.test(lowered)) peerType = "retail";
    else if (/\bindustry\b/.test(lowered)) peerType = "industry";
    else if (/\bcomparator\b/.test(lowered)) peerType = "comparator";
    else if (/\bperformance\b|\btsr\b/.test(lowered)) peerType = "performance";
    else if (/\bmedia\b/.test(lowered)) peerType = "media";

    const yearMatch = text.match(/\b(20\d{2})\b/);
    const disclosedYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;

    const key = members
      .map((m) => m.company_id_resolved ?? m.company_name_raw)
      .sort()
      .join("|");
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    groups.push({
      filing_id: filingId,
      peer_group_name: peerGroupName(disclosedYear, peerType),
      peer_group_type: peerType,
      disclosed_year: disclosedYear,
      selection_rationale: text,
      source_excerpt: cells.join(", ").slice(0, 600),
      confidence_score: 0.88,
      members,
      ...stamp(),
    });
  });

  // Path 2: table-first — scan every table with ≥7 company-like
  // cells; emit only when preceding text mentions a peer-group
  // concept AND doesn't mention directors/board/audit/NEOs (which
  // would indicate a different kind of table).
  $("table").each((_, table) => {
    const tableIdx = orderedIdx.get(table);
    if (tableIdx === undefined) return;
    const cells: string[] = [];
    $(table)
      .find("td, th")
      .each((_, cell) => {
        const cellText = $(cell).text().replace(/\s+/g, " ").trim();
        if (!isPeerCompanyCell(cellText)) return;
        if (cells.includes(cellText)) return;
        cells.push(cellText);
      });
    if (cells.length < 7) return;
    if (!precedingTextHasPeerIntro($, ordered, tableIdx)) return;

    const members: PeerGroupMemberRow[] = cells.map((name) => {
      const r = resolveCompanyName(name);
      return {
        company_name_raw: name,
        company_id_resolved: r.company_id,
        company_name_resolved: r.resolved_name ?? name,
        ticker_resolved: r.ticker,
        cik_resolved: r.cik,
        resolution_confidence: r.confidence,
      } as PeerGroupMemberRow;
    });
    const key = members
      .map((m) => m.company_id_resolved ?? m.company_name_raw)
      .sort()
      .join("|");
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const info = precedingTextInfo($, ordered, tableIdx);
    groups.push({
      filing_id: filingId,
      peer_group_name: peerGroupName(info.year, info.peerType),
      peer_group_type: info.peerType,
      disclosed_year: info.year,
      selection_rationale: info.intro,
      source_excerpt: cells.join(", ").slice(0, 600),
      confidence_score: 0.84,
      members,
      ...stamp(),
    });
  });

  return groups;
}

// ── Ticker-in-parens inline-text peer extractor ──────────────────────
//
// Modern SEC filers (TGT, MA, DIS, and many more) embed their peer
// list as a sequence of `Name (TICKER)` pairs inline in the page —
// often inside iXBRL-positioned divs that the cell-by-cell HTML-table
// extractor can't parse. The visible-text version of the document
// renders as a clean run:
//
//   "Abbott Laboratories (ABT) MetLife, Inc. (MET) Best Buy Co., Inc. (BBY) ..."
//
// We strip all HTML tags, scan the resulting text for runs of these
// pairs, validate each ticker against SEC's live ticker universe, and
// only emit a group when ≥7 valid tickers appear in close proximity.
// The validate-against-SEC step makes false positives extraordinarily
// unlikely — random capitalized text "Company X (ABC)" won't match
// unless ABC is a real SEC ticker AND a peer-group heading lives
// within 5000 chars upstream.

/** Stop-token prefixes for the name half of a Name+(TICKER) pair.
 * If a candidate "name" begins with any of these, the run breaks —
 * common patterns are paragraph starters like "Although" or "See" /
 * "Page" / "Table" / "Note" that occasionally precede a parenthesized
 * acronym in CD&A prose. */
const TICKER_RUN_NAME_REJECT = /^(?:see|page|table|note|item|figure|chart|exhibit|graph)\b/i;

/** Inline-list pair: `Company Name (TICKER)`. The name capture is
 * non-greedy and bounded: 1-7 words, each starting with an
 * uppercase letter (after the first word's mandatory uppercase) or a
 * common short connector ("of", "and"). The previous "max 60 chars"
 * matcher absorbed preceding prose ("Analysis 2025 peer groups
 * Retail Albertsons Companies, Inc.") into the name field — this
 * tighter shape stops at the last capital-led word boundary. */
const TICKER_INLINE_PAIR_PATTERN =
  /((?:[A-Z][A-Za-z0-9.'&\-]+(?:\s+(?:[A-Z][A-Za-z0-9.'&\-]+|of|and|the|de|für|für|y|&)){0,7})(?:,?\s+(?:Inc\.?|Incorporated|Corp\.?|Corporation|Company|Companies|Co\.?|LLC|Ltd\.?|Limited|Group|plc|Holdings|Holding|N\.?V\.?))?\.?)\s*\(([A-Z]{1,5}(?:[.\-]?[A-Z])?)\)/g;

/** Max characters between the peer-group heading and the start of
 * the ticker-pair run. iXBRL-positioned filings often have positioned
 * text streams that span far more bytes than visual layout suggests;
 * the run can be many KB after the nearest heading. The
 * ticker-validation guard is what prevents false positives, not this
 * proximity bound. */
const TICKER_INLINE_HEADING_PROXIMITY = 40_000;

/** Max characters between consecutive matches in a single run. If
 * the gap exceeds this, the run terminates and the next match starts
 * a new run. */
const TICKER_INLINE_RUN_GAP = 600;

/** Minimum number of matches in a run to count as a peer group. */
const TICKER_INLINE_MIN_MATCHES = 7;

interface RunMatch {
  name: string;
  ticker: string;
  start: number;
}

/** Find all consecutive Name+(TICKER) runs in `text`. Each returned
 * array has ≥ TICKER_INLINE_MIN_MATCHES entries. */
function findTickerInlineRuns(text: string): RunMatch[][] {
  const runs: RunMatch[][] = [];
  let current: RunMatch[] = [];
  let lastEnd = -1;
  TICKER_INLINE_PAIR_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TICKER_INLINE_PAIR_PATTERN.exec(text))) {
    const name = m[1].trim();
    const ticker = m[2];
    if (TICKER_RUN_NAME_REJECT.test(name)) {
      // Reject + end the current run.
      if (current.length >= TICKER_INLINE_MIN_MATCHES) runs.push(current);
      current = [];
      lastEnd = -1;
      continue;
    }
    if (lastEnd >= 0 && m.index - lastEnd > TICKER_INLINE_RUN_GAP) {
      if (current.length >= TICKER_INLINE_MIN_MATCHES) runs.push(current);
      current = [];
    }
    current.push({ name, ticker, start: m.index });
    lastEnd = m.index + m[0].length;
  }
  if (current.length >= TICKER_INLINE_MIN_MATCHES) runs.push(current);
  return runs;
}

/** Whole-document peer-group heading positions. Loose pattern — any
 * mention of "peer group" / "compensation peer" / "comparator group"
 * (case-insensitive) counts. The ticker-validation downstream is the
 * real gate against false positives. */
function findHeadingPositions(text: string): number[] {
  const positions: number[] = [];
  const re =
    /\b(?:compensation\s+peer|peer\s+(?:group|companies|company|set|composition)|comparator\s+group)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    positions.push(m.index);
    if (positions.length > 500) break;
  }
  return positions;
}

export function extractPeerGroupsFromTickerInline(
  filingId: string,
  html: string,
): Omit<PeerGroupRow, "id" | "section_id">[] {
  if (!html.trim()) return [];
  // Drop everything between < > then collapse whitespace + entities.
  // cheerio's `.text()` would also work; the raw replace is faster
  // for documents this large and avoids parsing.
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#8217;|&#x2019;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/\s+/g, " ");
  if (!text.trim()) return [];

  // Validate tickers against SEC's universe lazily — load the ticker
  // map once and check each candidate.
  const tickerMap = loadTickerMap();
  const validTickers = new Map<string, { name: string; cik: string }>();
  for (const e of Object.values(tickerMap)) {
    const t = String(e.ticker ?? "").toUpperCase();
    if (!t) continue;
    const cikRaw = e.cik_str ?? e.cik;
    const cik = cikRaw !== undefined && cikRaw !== null ? String(cikRaw).padStart(10, "0") : "";
    validTickers.set(t, { name: String(e.title ?? e.name ?? ""), cik });
  }

  const headings = findHeadingPositions(text);
  if (headings.length === 0) return [];

  const runs = findTickerInlineRuns(text);
  if (runs.length === 0) return [];

  const groups: Omit<PeerGroupRow, "id" | "section_id">[] = [];
  const usedRunStarts = new Set<number>();
  for (const run of runs) {
    // Must be preceded (within PROXIMITY) by a peer-group heading.
    const runStart = run[0].start;
    // Heading is allowed to land AT the run start (happens when the
    // regex name-capture absorbs the heading phrase into the first
    // member's name — common in iXBRL streams with no separator
    // punctuation between heading and the first peer pair).
    const upstream = headings.findLast(
      (h) => h <= runStart && runStart - h < TICKER_INLINE_HEADING_PROXIMITY,
    );
    if (upstream === undefined) continue;

    // Filter members to those whose ticker is a real SEC ticker.
    const seenTickers = new Set<string>();
    const members: PeerGroupMemberRow[] = [];
    for (const match of run) {
      const tickerUpper = match.ticker.toUpperCase();
      // Single-letter parentheticals are usually compensation-table
      // footnote markers, not ticker citations: an "All Other
      // Compensation" legend renders as "Contribution (A)", "Aircraft
      // Usage (F)", "Personal Security (G)", and A/B/C/D/E/F/G are all
      // real one-letter NYSE tickers, so a 7-row legend looks exactly
      // like a 7-member Name+(TICKER) run and clears the ≥7 gate (CRM
      // FY2026 emitted a bogus A–G peer group this way). Keep a
      // one-letter pair ONLY when the captured NAME independently
      // resolves to that same ticker ("Ford Motor Company (F)" → Ford);
      // legend categories resolve to nothing or to a different company,
      // so they drop out. This preserves real one-letter-ticker peers
      // (Ford, Citigroup, Visa, AT&T) instead of dropping them blindly.
      if (
        tickerUpper.length < 2 &&
        resolveCompanyName(match.name).ticker !== tickerUpper
      ) {
        continue;
      }
      const sec = validTickers.get(tickerUpper);
      if (!sec) continue;
      if (seenTickers.has(tickerUpper)) continue;
      seenTickers.add(tickerUpper);
      members.push({
        company_name_raw: `${match.name} (${match.ticker})`,
        company_id_resolved: tickerUpper.toLowerCase(),
        company_name_resolved: sec.name,
        ticker_resolved: tickerUpper,
        cik_resolved: sec.cik,
        resolution_confidence: 0.95,
      } as PeerGroupMemberRow);
    }
    if (members.length < TICKER_INLINE_MIN_MATCHES) continue;
    if (usedRunStarts.has(runStart)) continue;
    usedRunStarts.add(runStart);

    // Excerpt the heading text + the leading peer names for source.
    const sourceExcerpt = text
      .slice(upstream, Math.min(text.length, runStart + 400))
      .trim()
      .slice(0, 320);

    groups.push({
      filing_id: filingId,
      peer_group_name: "Peer Group",
      peer_group_type: null,
      disclosed_year: null,
      selection_rationale: null,
      source_excerpt: sourceExcerpt,
      confidence_score: 0.9,
      members,
      extractor_version: PEER_EXTRACTOR_VERSION + "+inline",
      extraction_method: "ticker-inline-run",
      source_document_name: null,
      source_document_sha: null,
      verification_status: "machine_extracted",
      review_status: "unreviewed",
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
    });
  }

  return groups;
}

// ── Suffix-terminated enumeration extractor ─────────────────────────
//
// DIS-style: peer companies enumerated as a comma-separated prose list
// outside CD&A.
//   "Apple Inc., AT&T Inc., Charter Communications, Inc., …, and Warner
//    Bros. Discovery, Inc."
//
// WMT-style: each company in its own <p> or <div>, no commas — after
// tag-strip the text becomes
//   "Costco Wholesale Corporation CVS Health Corp The Home Depot, Inc.
//    …"
//
// Both shapes are runs of corporate-suffix-terminated multi-word names
// in close proximity. We scan the full document for these and accept a
// run when ≥7 names resolve to real SEC companies via the existing
// resolver, AND the run is preceded (within 12000 chars) by a peer-
// group heading. Resolution + heading proximity together keep prose
// mentions ("Acme Inc. competes with Beta Corp.") from emitting a
// false group.

/** Corporate-suffix-terminated name pattern. The name body is 1-6
 * capital-led words; '|' (our element-boundary separator) is excluded
 * so a bullet-list layout doesn't concatenate multiple peers into a
 * single greedy match. */
const SUFFIX_TERMINATED_NAME = new RegExp(
  // 1-6 capital-led words; exclude the '|' boundary marker we insert
  // at closing tags below.
  "((?:[A-Z][A-Za-z0-9.'&\\-]+|The)(?:\\s+(?:[A-Z][A-Za-z0-9.'&\\-]+|of|and|the|de|y|&|-)){0,5})" +
    // The trailing corporate suffix.
    ",?\\s+" +
    "(Inc\\.?|Incorporated|Corp\\.?|Corporation|Company|Companies|Co\\.?|LLC|Ltd\\.?|Limited|Group|plc|Holdings|Holding|N\\.?V\\.?|S\\.?A\\.?|A\\.?G\\.?)" +
    "\\b\\.?",
  "g",
);

/** Reject names whose body contains heading-noise words. Without
 * this, WMT's "Walmart Proxy Peer Group Albertsons Companies Inc."
 * would resolve as the filer itself. */
const SUFFIX_NAME_REJECT = /\b(?:Proxy|Peer|Group|Compensation|Discussion|Following|Below|Items?|See\b|Note)\b/i;

/** Max characters between consecutive resolved members in a run. */
const SUFFIX_RUN_GAP = 250;
const SUFFIX_MIN_MATCHES = 7;
const SUFFIX_HEADING_PROXIMITY = 12_000;

interface SuffixRunMatch {
  rawName: string;
  start: number;
  resolved: ResolvedMember;
}

function findSuffixRuns(text: string): SuffixRunMatch[][] {
  const runs: SuffixRunMatch[][] = [];
  let current: SuffixRunMatch[] = [];
  let lastEnd = -1;
  SUFFIX_TERMINATED_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUFFIX_TERMINATED_NAME.exec(text))) {
    const fullMatch = m[0];
    const namePrefix = m[1] ?? "";
    const suffix = m[2] ?? "";
    if (!namePrefix || !suffix) continue;
    // Reject names containing heading-noise words ("Peer Group",
    // "Proxy", etc.) so the run can't absorb the heading into the
    // first member.
    if (SUFFIX_NAME_REJECT.test(namePrefix)) {
      if (lastEnd >= 0 && m.index - lastEnd > SUFFIX_RUN_GAP) {
        if (current.length >= SUFFIX_MIN_MATCHES) runs.push(current);
        current = [];
        lastEnd = -1;
      }
      continue;
    }
    // Reject names containing the boundary marker we inserted —
    // means the regex crossed two block elements.
    if (namePrefix.includes("|")) continue;
    const rawName = `${namePrefix} ${suffix}`.replace(/\s+/g, " ").trim();
    // Resolve via the existing CompanyResolver; the blocklist + alias
    // index already provide the false-positive filtering.
    const matches = findCompanies(rawName);
    if (matches.length === 0) {
      if (lastEnd >= 0 && m.index - lastEnd > SUFFIX_RUN_GAP) {
        if (current.length >= SUFFIX_MIN_MATCHES) runs.push(current);
        current = [];
        lastEnd = -1;
      }
      continue;
    }
    const resolved = matches[0];
    if (lastEnd >= 0 && m.index - lastEnd > SUFFIX_RUN_GAP) {
      if (current.length >= SUFFIX_MIN_MATCHES) runs.push(current);
      current = [];
    }
    current.push({ rawName, start: m.index, resolved });
    lastEnd = m.index + fullMatch.length;
  }
  if (current.length >= SUFFIX_MIN_MATCHES) runs.push(current);
  return runs;
}

export function extractPeerGroupsFromSuffixEnumeration(
  filingId: string,
  html: string,
): Omit<PeerGroupRow, "id" | "section_id">[] {
  if (!html.trim()) return [];
  // Insert a `|` separator at every block-level closing tag so a
  // bullet-list layout (one company per <p>) doesn't concatenate into
  // a single greedy match. The regex then can't cross those bounds.
  const text = html
    .replace(/<\/(?:p|div|li|td|tr|span|h[1-6])>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#8217;|&#x2019;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/\s+/g, " ");
  if (!text.trim()) return [];

  const headings = findHeadingPositions(text);
  if (headings.length === 0) return [];

  const runs = findSuffixRuns(text);
  if (runs.length === 0) return [];

  const groups: Omit<PeerGroupRow, "id" | "section_id">[] = [];
  const usedRunStarts = new Set<number>();
  for (const run of runs) {
    const runStart = run[0].start;
    const upstream = headings.findLast(
      (h) => h <= runStart && runStart - h < SUFFIX_HEADING_PROXIMITY,
    );
    if (upstream === undefined) continue;

    // Dedupe within a run by resolved company id.
    const seenIds = new Set<string>();
    const members: PeerGroupMemberRow[] = [];
    for (const match of run) {
      const id = match.resolved.company_id_resolved;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      members.push({
        company_name_raw: match.rawName,
        company_id_resolved: match.resolved.company_id_resolved,
        company_name_resolved: match.resolved.company_name_resolved,
        ticker_resolved: match.resolved.ticker_resolved,
        cik_resolved: match.resolved.cik_resolved,
        resolution_confidence: match.resolved.resolution_confidence ?? 0.85,
      } as PeerGroupMemberRow);
    }
    if (members.length < SUFFIX_MIN_MATCHES) continue;
    if (usedRunStarts.has(runStart)) continue;
    usedRunStarts.add(runStart);

    const sourceExcerpt = text
      .slice(upstream, Math.min(text.length, runStart + 400))
      .trim()
      .slice(0, 320);

    groups.push({
      filing_id: filingId,
      peer_group_name: "Peer Group",
      peer_group_type: null,
      disclosed_year: null,
      selection_rationale: null,
      source_excerpt: sourceExcerpt,
      confidence_score: 0.88,
      members,
      extractor_version: PEER_EXTRACTOR_VERSION + "+suffix",
      extraction_method: "suffix-enumeration-run",
      source_document_name: null,
      source_document_sha: null,
      verification_status: "machine_extracted",
      review_status: "unreviewed",
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
    });
  }
  return groups;
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
