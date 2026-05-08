/**
 * Policy + metric fact extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/fact_extractor.py.
 *
 * Faithful 1:1 port of the rule tables (POLICY_RULES, METRIC_RULES,
 * SPECIAL_METRIC_PATTERNS, hint sets, trim anchors) and the
 * best-candidate scoring logic. Company-specific branches for
 * Microsoft/Salesforce equity-mix variants are preserved.
 *
 * The Python regex flavor is mostly compatible with JS; named groups
 * (?P<name>...) → (?<name>...). Use `i` for IGNORECASE, `s` for DOTALL.
 *
 * Drift tracking: `facts.parity.test.ts` walks every fixture filing
 * and asserts the TS extractor produces the same {policy_type,
 * normalized_value} pairs and {metric_name_normalized, observed_value}
 * pairs the Python oracle produced. Diffs are surfaced, not failed,
 * until each rule individually proves parity.
 */
import type { PolicyFactRow, MetricFactRow } from "@/lib/types";

export const FACT_EXTRACTOR_VERSION = "fact_extractor.ts.v1";

// ── Rule tables (mirror fact_extractor.py:9-67) ──────────────────────

interface PolicyRule {
  policyType: string;
  pattern: RegExp;
  confidence: number;
}

interface MetricRule {
  raw: string;
  normalized: string;
  category: string | null;
  planType: string | null;
  pattern: RegExp;
  confidence: number;
}

const POLICY_RULES: PolicyRule[] = [
  { policyType: "hedging", pattern: /\bhedging\b/i, confidence: 0.93 },
  { policyType: "pledging", pattern: /\bpledging\b/i, confidence: 0.93 },
  { policyType: "clawback", pattern: /\b(recoupment|clawback|erroneously awarded)\b/i, confidence: 0.96 },
  {
    policyType: "stock_ownership_guidelines",
    pattern: /\b(stock ownership (?:guidelines|policy)|ownership guidelines that require (?:them|executives) to maintain significant ownership)\b/i,
    confidence: 0.94,
  },
  { policyType: "change_in_control", pattern: /\bchange (?:in|of) control\b/i, confidence: 0.92 },
  { policyType: "compensation_consultant", pattern: /\bcompensation consultant\b/i, confidence: 0.86 },
  // Compensation committee — name varies (Compensation, People and
  // Compensation, Talent and Compensation, Human Resources and
  // Compensation, Leadership Development and Compensation).
  {
    policyType: "compensation_committee",
    pattern:
      /\b(?:[A-Z][a-z]+\s+(?:and\s+[A-Z][a-z]+\s+)?(?:and\s+)?)?Compensation\s+Committee\b/,
    confidence: 0.85,
  },
];

const METRIC_RULES: MetricRule[] = [
  { raw: "Relative TSR", normalized: "relative_tsr", category: "shareholder_return", planType: "long_term_incentive", pattern: /\b(relative tsr|relative total shareholder return)\b/i, confidence: 0.95 },
  { raw: "Total Shareholder Return", normalized: "tsr", category: "shareholder_return", planType: "long_term_incentive", pattern: /\btotal shareholder return\b/i, confidence: 0.88 },
  { raw: "Revenue", normalized: "revenue", category: "financial", planType: "annual", pattern: /\b(revenue|net sales)\b/i, confidence: 0.88 },
  { raw: "Operating Income", normalized: "operating_income", category: "financial", planType: "annual", pattern: /\boperating income\b/i, confidence: 0.9 },
  { raw: "Annual Incentive Payout", normalized: "annual_incentive_payout", category: "annual_incentive", planType: "annual", pattern: /\b(cash incentive plan|bonus plan|overall bonus|company performance percentage)\b/i, confidence: 0.9 },
  { raw: "Performance RSU Vesting", normalized: "performance_rsu_vesting", category: "equity", planType: "long_term_incentive", pattern: /\b(performance-based rsus?|performance-based equity awards?)\b/i, confidence: 0.9 },
  { raw: "Performance Equity Mix", normalized: "performance_equity_mix", category: "equity", planType: "long_term_incentive", pattern: /\b(performance-based rsus?|performance-based stock award)\b/i, confidence: 0.84 },
  { raw: "Time Equity Mix", normalized: "time_equity_mix", category: "equity", planType: "long_term_incentive", pattern: /\btime-based (?:rsus?|stock awards?)\b/i, confidence: 0.82 },
  { raw: "Say on Pay", normalized: "say_on_pay", category: "governance", planType: null, pattern: /\bsay on pay\b/i, confidence: 0.84 },
  // CEO pay ratio (Item 402(u)). Anchor patterns find the disclosure;
  // SPECIAL_METRIC_PATTERNS extracts the numeric value.
  { raw: "CEO Pay Ratio", normalized: "ceo_pay_ratio", category: "pay_ratio", planType: null, pattern: /\b(?:ceo|chief\s+executive\s+officer)\s+pay\s+ratio\b|\bratio\s+of\s+(?:our\s+)?(?:ceo|chief\s+executive\s+officer)(?:'s)?\s+(?:annual\s+)?(?:total\s+)?compensation\s+to\s+(?:our\s+)?median\b/i, confidence: 0.94 },
  { raw: "Median Employee Compensation", normalized: "median_employee_compensation", category: "pay_ratio", planType: null, pattern: /\bmedian\s+(?:compensated\s+)?employee\b/i, confidence: 0.9 },
];

// ── Value extraction (mirror fact_extractor.py:69-97) ────────────────

const PERCENTILE_VALUE = /\b\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile\b/i;
const PERCENT_VALUE = /\b(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%/i;
const CURRENCY_VALUE = /\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?/i;
const DEFAULT_VALUE_PATTERNS: RegExp[] = [PERCENTILE_VALUE, CURRENCY_VALUE, PERCENT_VALUE];
const RATIO_VALUE = /\b\d{1,5}(?:\.\d+)?\s*(?:to|:)\s*1\b/i;
const FULL_DOLLAR_VALUE = /\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?/;
const METRIC_VALUE_PATTERNS: Record<string, RegExp[]> = {
  relative_tsr: [PERCENTILE_VALUE, PERCENT_VALUE],
  tsr: [PERCENT_VALUE, PERCENTILE_VALUE, CURRENCY_VALUE],
  revenue: [CURRENCY_VALUE, PERCENT_VALUE],
  operating_income: [CURRENCY_VALUE, PERCENT_VALUE],
  annual_incentive_payout: [PERCENT_VALUE],
  performance_rsu_vesting: [PERCENT_VALUE],
  performance_equity_mix: [PERCENT_VALUE],
  time_equity_mix: [PERCENT_VALUE],
  say_on_pay: [PERCENT_VALUE],
  ceo_pay_ratio: [RATIO_VALUE],
  median_employee_compensation: [FULL_DOLLAR_VALUE],
};

// ── Hints (mirror fact_extractor.py:99-211, 413-548) ─────────────────

const METRIC_POSITIVE_HINTS: Record<string, string[]> = {
  revenue: [
    "strong financial performance", "financial performance",
    "strong business execution", "business performance highlights",
    "total revenue", "all-time revenue record",
    "reported net sales", "reported revenue",
  ],
  operating_income: [
    "strong financial performance", "financial performance",
    "business performance highlights", "operating income results",
  ],
  say_on_pay: [
    "votes cast", "in favor", "annual meeting",
    "advisory proposal", "shareholder vote",
  ],
  relative_tsr: [
    "percentile", "s&p 500", "peer group index", "modifier",
    "was at the", "based on this result",
    "achieving a relative total shareholder return at the",
    "our tsr relative to", "our tsr for the",
  ],
  tsr: [
    "cumulative", "shareholder return", "through june",
    "market capitalization", "ceo tenure",
  ],
  annual_incentive_payout: [
    "maximum payout", "company performance percentage",
    "cash incentive plan", "bonus payouts", "bonus payouts equal to",
    "no bonus payment", "overall bonus", "payout under",
    "award funding of", "translated into award funding",
  ],
  performance_rsu_vesting: [
    "vested in", "target performance-based rsus",
    "maximum number of performance-based rsus",
  ],
  performance_equity_mix: [
    "each named executive officer", "performance-based and",
    "other named executives",
  ],
  time_equity_mix: [
    "each named executive officer", "time-based rsus", "time-based vesting",
  ],
};

const METRIC_NEGATIVE_HINTS: Record<string, string[]> = {
  revenue: [
    "peer group", "selection criteria", "minimum revenue",
    "market capitalization", "threshold", "talent competitor",
    "incentive plan revenue", "microsoft cloud revenue",
    "linkedin revenue", "search and news advertising revenue",
    "xbox content and services revenue",
  ],
  operating_income: ["peer group", "selection criteria", "incentive plan operating income"],
  annual_incentive_payout: [
    "say on pay", "target cash incentive", "target bonus percentage",
    "target bonus opportunit", "cash bonus opportunity", "base salary",
    "multiplied by", "required for 100% payout", "for 100% payout",
    "threshold financial performance",
  ],
  relative_tsr: [
    "must be above", "at or above the", "require outperformance",
    "to earn target payouts", "performance levels and payout scales",
    "open performance periods", "may be earned",
    "will be determined following the end",
  ],
  performance_rsu_vesting: ["subject to performance-based vesting"],
  performance_equity_mix: ["vested in", "maximum number of performance-based rsus"],
  time_equity_mix: ["vested in"],
  say_on_pay: ["say on frequency"],
};

const POLICY_POSITIVE_HINTS: Record<string, string[]> = {
  hedging: ["prohibit", "hedging activities", "transactions in derivatives"],
  pledging: ["prohibit", "pledging", "collateral for loans", "margin accounts"],
  clawback: [
    "clawback policy", "recoupment policy", "allows for recoupment",
    "recovery of any erroneously awarded", "recovery of annual cash incentives",
  ],
  stock_ownership_guidelines: [
    "stock ownership guidelines", "stock ownership policy",
    "maintain significant ownership", "requiring stock ownership",
    "15x base salary", "ten times annual base salary",
    "reinforces the alignment", "robust stock ownership policy",
  ],
  change_in_control: [
    "no change in control payments", "no change of control payments",
    "not entitled to acceleration", "not entitled to payments",
    "none of our named executive officers is entitled",
  ],
  compensation_consultant: [
    "independent compensation consultant",
    "retains an independent compensation consultant",
    "engages an independent compensation consultant",
    "compensia",
  ],
};

const POLICY_NEGATIVE_HINTS: Record<string, string[]> = {
  clawback: ["assisted by our stock ownership policy"],
  stock_ownership_guidelines: [
    "assisted by our stock ownership policy",
    "risk-taking", "compensation recovery",
  ],
};

const POLICY_TRIM_ANCHORS: Record<string, string[]> = {
  hedging: ["prohibition on hedging", "we prohibit hedging", "hedging activities"],
  pledging: [
    "prohibition on hedging, pledging",
    "we prohibit short sales, transactions in derivatives, hedging, and pledging",
    "pledging of company securities",
  ],
  clawback: [
    "clawback policy", "compensation recoupment policies",
    "recoupment policy", "recovery of any erroneously awarded",
  ],
  stock_ownership_guidelines: [
    "stock ownership guidelines",
    "maintain a robust stock ownership policy",
    "maintain a stock ownership policy",
    "our executives are subject to stock ownership guidelines",
  ],
  change_in_control: [
    "no change in control payments", "no change of control payments",
    "none of our named executive officers is entitled",
  ],
  compensation_consultant: [
    "independent compensation consultant",
    "retain an independent compensation consultant",
    "retains an independent compensation consultant",
    "engages an independent compensation consultant",
  ],
};

const METRIC_TRIM_ANCHORS: Record<string, string[]> = {
  annual_incentive_payout: [
    "bonus payouts equal to", "received no bonus payment",
    "resulting in a maximum payout", "final cash incentive plan payout",
    "weighted payout", "company performance percentage",
    "overall bonus", "award funding of",
  ],
  relative_tsr: [
    "our tsr relative to", "our tsr for the",
    "total shareholder return relative to",
    "achieving a relative total shareholder return at the",
    "relative total shareholder return modifier payout",
  ],
  performance_rsu_vesting: [
    "as a result", "vested in", "vested on", "vested upon",
    "earned prsu shares vested",
    "maximum number of performance-based rsus", "maximum vesting",
  ],
  performance_equity_mix: [
    "each named executive officer",
    "other neos’ long-term equity award mix",
    "other neos' long-term equity award mix",
    "100% of our ceo",
  ],
  time_equity_mix: [
    "each named executive officer",
    "other neos’ long-term equity award mix",
    "other neos' long-term equity award mix",
    "100% of our ceo",
  ],
  say_on_pay: [
    "at our", "say-on-pay proposal", "say on pay proposal", "votes cast",
  ],
};

// ── Special metric patterns (mirror fact_extractor.py:219-376) ───────

const SPECIAL_METRIC_PATTERNS: Record<string, RegExp[]> = {
  revenue: [
    /\bfiscal year\s+20\d{2}\s+business performance(?:\s+highlights)?(?:\s+percentages are year-over-year)?\s+revenue\s+operating income\s+net income\s+diluted earnings per share\s+(?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/is,
    /\ball-time revenue record of (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
    /\btotal revenue of (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
    /\breported (?:net sales|revenue) of (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
    /\btripling revenue to (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
  ],
  operating_income: [
    /\bfiscal year\s+20\d{2}\s+business performance(?:\s+highlights)?(?:\s+percentages are year-over-year)?\s+revenue\s+operating income\s+net income\s+diluted earnings per share\s+\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?\s+(?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/is,
    /\boperating income results of (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
    /\breported operating income of (?<value>\$\s*\d+(?:\.\d+)?\s*(?:billion|million|trillion)?)/i,
  ],
  annual_incentive_payout: [
    /\b(?<value>\d+(?:\.\d+)?%)\s+payout under (?:our\s+)?(?:\d{4}\s+)?(?:annual\s+)?(?:cash incentive plan|variable cash plan)\b/i,
    /\b(?:translated into )?award funding of\s+(?<value>\d+(?:\.\d+)?%).{0,160}?\b(?:the\s+)?(?:\d{4}\s+)?(?:acip|annual cash incentive plan|cash incentive plan)\b/is,
    /\bfinal cash incentive plan payout of (?<value>\d+(?:\.\d+)?%\s+of\s+target)\b/i,
    /\bweighted payout of (?<value>\d+(?:\.\d+)?%)\s+as a percentage of target\b/i,
    /\boverall bonus:\s*(?<value>\d+(?:\.\d+)?%)/i,
    /\bbonus payouts equal to (?<value>\d+(?:\.\d+)?%)\s+of\s+(?:the\s+)?total\s+target\s+bonus\s+opportunity\b/i,
    /\b(?:approved|determined)\s+(?:a\s+)?company performance percentage of (?<value>\d+(?:\.\d+)?%)/i,
    /\breceived (?<value>no bonus payment)\b/i,
    /\bresulting in a (?<value>maximum payout(?: opportunity)?)\b.{0,140}?\bcash incentive plan\b/is,
  ],
  performance_rsu_vesting: [
    /\bvested in (?<value>\d+(?:\.\d+)?%) of the target performance-based rsus?\b/i,
    /\bvested in the (?<value>maximum number) of performance-based rsus?\b/i,
    /\b(?<value>\d+(?:\.\d+)?%)\s+of\s+the\s+target\s+prsus?\b.{0,220}?\bvested\b/is,
  ],
  performance_equity_mix: [
    /\beach named executive officer.{0,220}?\bof (?<value>\d+(?:\.\d+)?%) performance-based and \d+(?:\.\d+)?% time-based rsus?\b/is,
    /\bperformance-based stock award \((?<value>\d+(?:\.\d+)?%) for our other named executives\)/i,
    /\blong-term equity award mix\b.{0,220}?\bmaintaining a (?<value>\d+(?:\.\d+)?)% performance-based weighting\b/is,
  ],
  time_equity_mix: [
    /\beach named executive officer.{0,220}?\bof \d+(?:\.\d+)?% performance-based and (?<value>\d+(?:\.\d+)?%) time-based rsus?\b/is,
  ],
  say_on_pay: [
    /(?<value>(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%)\s+of\s+(?:the\s+)?votes\s+cast.{0,160}?\bsay on pay\b/is,
    /(?<value>(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%)\s+of\s+(?:the\s+)?votes\s+cast\s+(?:approved|supported|were\s+in\s+favor\s+of|voting\s+in\s+favor\s+of|in\s+favor\s+of)\b.{0,240}?(?:say[\s-]on[\s-]pay|advisory\s+(?:resolution|vote)|compensation\s+of\s+our\s+(?:named\s+executive\s+officers|named\s+executives|neos?)|NEO\s+compensation)/is,
    /(?:our\s+)?say[\s-]on[\s-]pay\s+proposal\s+(?:received|resulted\s+in)\s+(?<value>(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%)\s+support\b/i,
  ],
  relative_tsr: [
    /\bachieving\s+a\s+relative\s+total\s+shareholder\s+return\s+at\s+the\s+(?<value>\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile)\b/i,
    /\bour\s+tsr\b.{0,280}?\bwas\s+at\s+the\s+(?<value>\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile)\b/is,
    /\brelative\s+total\s+shareholder\s+return\s+modifier\s+payout\b.{0,240}?\b(?<value>\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile)\b/is,
    /\brelative\s+tsr\b.{0,240}?\bwas\s+at\s+the\s+(?<value>\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile)\b/is,
    /\brelative\s+tsr\b.{0,240}?\babove\s+the\s+(?<value>\d+(?:\.\d+)?\s*(?:st|nd|rd|th)\s+percentile)\b/is,
  ],
  tsr: [
    /\bcumulative total shareholder return\b.{0,400}?\b(?<value>(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%)/is,
    /\bfiscal year\s+20\d{2}\s+total shareholder return of (?<value>(?:over|approximately|about|around|nearly|more than|less than|under)?\s*\d+(?:\.\d+)?\s*%)/is,
  ],
  ceo_pay_ratio: [
    // "Ratio of [CEO] to [Median Employee] total compensation [verb] N:1"
    // Allows up to ~80 chars of filler so we don't fail when disclosures
    // include phrases like "annual total compensation" between the
    // CEO/median anchors. The verb (is|was) is optional — many proxies
    // present the ratio as a header line with no verb.
    /\bratio\s+of\s+(?:the\s+|our\s+)?(?:chief\s+executive\s+officer|ceo)(?:[a-z\s']*?)\bto\s+(?:the\s+|our\s+)?median(?:\s+(?:compensated\s+)?employee)?(?:[a-z\s']*?)\b(?:total\s+compensation\s*)?(?:was\s+|is\s+|of\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:to|:)\s*1)\b/is,
    // "[fiscal year YYYY|YYYY] pay ratio [verb] N:1" — year-anchored
    // form preferred over generic "pay ratio of N:1" so we don't latch
    // onto historical comparison sentences ("our 2020 pay ratio was 27:1").
    /\b(?:fiscal\s+(?:year\s+)?)?20\d{2}\s+pay\s+ratio\s+(?:was|is)\s+(?:approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:to|:)\s*1)\b/i,
    // Fallback: "pay ratio is N:1" with no year qualifier.
    /\bpay\s+ratio\s+(?:of\s+|was\s+|is\s+)(?:approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:to|:)\s*1)\b/is,
  ],
  median_employee_compensation: [
    // "Median Employee total compensation in YYYY $X" (GOOGL).
    /\bmedian\s+(?:compensated\s+)?employee(?:'s)?\s+(?:annual\s+)?total\s+compensation\s+(?:in\s+20\d{2}\s+)?(?:was\s+|is\s+|of\s+)?(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
    // "annual total compensation of our median (compensated) employee
    // [verb] $X" (Item 402(u) canonical phrasing).
    /\bannual\s+total\s+compensation\s+of\s+(?:the\s+|our\s+)?median\s+(?:compensated\s+)?employee\s+(?:was|is)\s+(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
    // "median of the annual total compensation of all employees …
    // was $X" (META variant — phrasing reversed but the value is the
    // median employee comp).
    /\bmedian\s+of\s+the\s+annual\s+total\s+compensation\s+of\s+all\s+(?:other\s+)?employees(?:[^.]{0,160}?)\s+(?:was|is)\s+(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
  ],
};

// ── Special equity-mix branches (Microsoft, Salesforce) ──────────────
// Mirror fact_extractor.py:712-776 / D-002 P1-6.

const MSFT_OTHER_NEO_PATTERN =
  /\b100%\s+of\s+our\s+ceo(?:[’']s|\s+s)?\s+annual\s+target\s+equity\s+opportunity\s+was\s+delivered\s+in\s+the\s+form\s+of\s+a\s+performance-based\s+stock\s+award\s+\((?<value>\d+(?:\.\d+)?)%\s+for\s+our\s+other\s+named\s+executives\)/i;
const RSU_ONLY_PATTERN = /\bequity-based compensation in the form of rsus?\b/i;
const PERFORMANCE_BASED_AWARD_PATTERN = /\bperformance-based\s+(?:rsus?|stock award)\b/i;
const SALESFORCE_MIX_PATTERN =
  /\blong-term equity award mix\b.{0,220}?\bmaintaining a (?<value>\d+(?:\.\d+)?)% performance-based weighting\b/is;

const FINANCIAL_TABLE_LABELS: { name: string; pattern: RegExp }[] = [
  { name: "revenue", pattern: /\brevenue\b/i },
  { name: "operating_income", pattern: /\boperating income\b/i },
  { name: "net_income", pattern: /\bnet income\b/i },
  { name: "diluted_eps", pattern: /\bdiluted earnings per share\b/i },
];

// ── Candidate types ──────────────────────────────────────────────────

interface PolicyCandidate {
  excerpt: string;
  normalized_value: string | null;
  score: number;
}

interface MetricCandidate {
  excerpt: string;
  observed_value: string | null;
  score: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function stamp() {
  return {
    extractor_version: FACT_EXTRACTOR_VERSION,
    extraction_method: "regex-fact-rule",
    source_document_name: null,
    source_document_sha: null,
    verification_status: "machine_extracted" as const,
    review_status: "unreviewed" as const,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
  };
}

function findAll(text: string, pattern: RegExp): RegExpExecArray[] {
  // Python's re.finditer over a bare flag set is global; ensure /g.
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return out;
}

function searchOnce(text: string, pattern: RegExp): RegExpExecArray | null {
  const re = pattern.flags.includes("g")
    ? new RegExp(pattern.source, pattern.flags.replace("g", ""))
    : pattern;
  return re.exec(text);
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Python rfind(needle, 0, start) requires `index + len(needle) <= start`.
// JS lastIndexOf(needle, fromIndex) allows `index <= fromIndex`. The
// equivalent is `lastIndexOf(needle, start - needle.length)`.
function rfindBefore(text: string, needle: string, start: number): number {
  if (needle.length === 0 || start < needle.length) return -1;
  return text.lastIndexOf(needle, start - needle.length);
}

function trimEnds(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

function valueKind(value: string | null): string | null {
  if (value === null) return null;
  const lowered = value.toLowerCase();
  if (lowered.includes("percentile")) return "percentile";
  if (lowered.startsWith("$")) return "currency";
  if (lowered.includes("%")) return "percent";
  return "other";
}

function cleanValue(value: string): string {
  let cleaned = value.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^(?:over|approximately|about|around|nearly|more than|less than|under)\s+/i, "");
  cleaned = cleaned.replace(/\$\s+/g, "$");
  cleaned = cleaned.replace(/\s+%/g, "%");
  cleaned = cleaned.replace(/(\d)\s+(st|nd|rd|th)\b/gi, "$1$2");
  const lowered = cleaned.toLowerCase();
  if (lowered === "maximum number") return "maximum vesting";
  if (lowered === "maximum payout opportunity") return "maximum payout";
  return cleaned;
}

// ── Excerpt extraction ───────────────────────────────────────────────

function policyExcerpt(text: string, start: number, end: number): string {
  const bullets = [rfindBefore(text, "•", start), rfindBefore(text, "◦", start)].filter(
    (i) => i !== -1,
  );
  const nearbyBullet = bullets.length ? Math.max(...bullets) : -1;
  let left: number;
  if (nearbyBullet !== -1 && start - nearbyBullet <= 80) {
    left = nearbyBullet + 1;
  } else {
    const paragraphBoundary = rfindBefore(text, "\n\n", start);
    if (paragraphBoundary !== -1 && start - paragraphBoundary <= 260) {
      left = paragraphBoundary + 2;
    } else {
      const sentenceBoundaries = [
        rfindBefore(text, ". ", start),
        rfindBefore(text, "; ", start),
        rfindBefore(text, ": ", start),
      ].filter((i) => i !== -1 && start - i <= 260);
      if (sentenceBoundaries.length === 0) {
        left = 0;
      } else {
        const sentenceLeft = Math.max(...sentenceBoundaries) + 2;
        left = start - sentenceLeft <= 220 ? sentenceLeft : Math.max(0, start - 160);
      }
    }
  }

  const rightCandidates = [
    text.indexOf("•", end),
    text.indexOf("◦", end),
    text.indexOf(". ", end),
    text.indexOf("\n\n", end),
    text.indexOf("; ", end),
  ].filter((i) => i !== -1);
  const right = rightCandidates.length
    ? Math.min(...rightCandidates)
    : Math.min(text.length, end + 260);

  const excerpt = trimEnds(collapseWs(text.slice(left, right)), " •◦;:");
  return excerpt.slice(0, 900);
}

function trimPolicyExcerpt(policyType: string, excerpt: string): string {
  const lowered = excerpt.toLowerCase();
  const anchors = POLICY_TRIM_ANCHORS[policyType] ?? [];
  const starts = anchors.map((a) => lowered.indexOf(a)).filter((i) => i !== -1);
  let result = starts.length ? excerpt.slice(Math.min(...starts)) : excerpt;
  result = trimEnds(result, " •◦;:");
  return result.slice(0, 900);
}

function basicExcerpt(text: string, start: number, end: number, window = 220): string {
  let left = Math.max(0, start - window);
  let right = Math.min(text.length, end + window);
  while (left < start && left > 0 && !/\s/.test(text[left])) left += 1;
  while (right < text.length && right > end && !/\s/.test(text[right - 1])) right -= 1;
  return collapseWs(text.slice(left, right));
}

function previousSentenceBoundary(text: string, start: number, maxDistance: number): number | null {
  let lastIndex: number | null = null;
  const re = /\.(?:\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.slice(0, start))) !== null) {
    lastIndex = m.index;
  }
  if (lastIndex === null) return null;
  if (start - lastIndex > maxDistance) return null;
  return lastIndex + 1;
}

function nextSentenceBoundary(text: string, end: number, maxDistance: number): number | null {
  const re = /\.(?:\s|$)/;
  const m = re.exec(text.slice(end));
  if (m === null || m.index > maxDistance) return null;
  return end + m.index + 1;
}

function metricLeftBoundary(text: string, start: number): number {
  const sentence = previousSentenceBoundary(text, start, 320);
  const candidates: number[] = [];
  const sources: { boundary: number; offset: number; max: number }[] = [
    { boundary: rfindBefore(text, "•", start), offset: 1, max: 220 },
    { boundary: rfindBefore(text, "◦", start), offset: 1, max: 220 },
    { boundary: rfindBefore(text, "\n\n", start), offset: 2, max: 320 },
    { boundary: rfindBefore(text, ": ", start), offset: 2, max: 260 },
  ];
  for (const { boundary, offset, max } of sources) {
    if (boundary !== -1 && start - boundary <= max) {
      candidates.push(boundary + offset);
    }
  }
  if (sentence !== null) candidates.push(sentence);
  return candidates.length > 0 ? Math.max(...candidates) : Math.max(0, start - 220);
}

function metricRightBoundary(text: string, end: number): number {
  const sentence = nextSentenceBoundary(text, end, 420);
  const candidates: number[] = [];
  const sources: { boundary: number; offset: number; max: number }[] = [
    { boundary: text.indexOf("•", end), offset: 0, max: 420 },
    { boundary: text.indexOf("◦", end), offset: 0, max: 420 },
    { boundary: text.indexOf("\n\n", end), offset: 0, max: 420 },
  ];
  for (const { boundary, offset, max } of sources) {
    if (boundary !== -1 && boundary - end <= max) {
      candidates.push(boundary + offset);
    }
  }
  if (sentence !== null) candidates.push(sentence);
  return candidates.length > 0 ? Math.min(...candidates) : Math.min(text.length, end + 420);
}

function trimMetricExcerpt(metricNorm: string, excerpt: string): string {
  const lowered = excerpt.toLowerCase();
  const anchors = METRIC_TRIM_ANCHORS[metricNorm] ?? [];
  const starts = anchors.map((a) => lowered.indexOf(a)).filter((i) => i !== -1);
  let result = starts.length ? excerpt.slice(Math.min(...starts)) : excerpt;
  result = trimEnds(result, " •◦;:");
  return result.slice(0, 900);
}

function focusedMetricExcerpt(text: string, start: number, end: number, metricNorm: string | null): string | null {
  if (metricNorm === null || !(metricNorm in METRIC_TRIM_ANCHORS)) return null;
  const left = metricLeftBoundary(text, start);
  const right = metricRightBoundary(text, end);
  let excerpt = trimEnds(collapseWs(text.slice(left, right)), " •◦;:");
  excerpt = trimMetricExcerpt(metricNorm, excerpt);
  if (excerpt.length < 25) return null;
  return excerpt;
}

function metricExcerpt(text: string, start: number, end: number, metricNorm: string | null): string {
  const focused = focusedMetricExcerpt(text, start, end, metricNorm);
  if (focused !== null) return focused.slice(0, 1500);
  let excerpt = basicExcerpt(text, start, end, 320);
  if (metricNorm !== null) excerpt = trimMetricExcerpt(metricNorm, excerpt);
  return excerpt.slice(0, 1500);
}

// ── Normalization + scoring ──────────────────────────────────────────

function normalizePolicyValue(policyType: string, excerpt: string): string | null {
  const lowered = excerpt.toLowerCase();
  if ((policyType === "hedging" || policyType === "pledging") && lowered.includes("prohibit")) {
    return "prohibited";
  }
  if (policyType === "change_in_control") {
    if (
      lowered.includes("no change of control payments") ||
      lowered.includes("no change in control payments") ||
      lowered.includes("not entitled to acceleration") ||
      lowered.includes("not entitled to payments") ||
      lowered.includes("none of our named executive officers is entitled")
    ) {
      return "none";
    }
  }
  if (policyType === "clawback") {
    if (lowered.includes("discretionary") && lowered.includes("required")) return "required_and_discretionary";
    if (lowered.includes("discretionary")) return "discretionary";
    return "present";
  }
  if (policyType === "stock_ownership_guidelines") return "present";
  if (policyType === "compensation_consultant" && lowered.includes("independent")) return "independent";
  if (policyType === "compensation_committee") {
    // Distinguish committees with closed-form qualifiers (mirrors how
    // S&P 500 boards actually name their compensation committees).
    // Anything outside this list — including pronouns ("Our") or
    // accidental name+committee captures ("Haley Compensation
    // Committee") — collapses to the canonical "Compensation Committee".
    const qualifiers = [
      "Human Capital Management and",
      "Leadership Development and",
      "Human Resources and",
      "Human Capital and",
      "Management Development and",
      "Talent Development and",
      "People and",
      "Talent and",
      "Personnel and",
      "Executive",
      "Compensation and Talent",
      "Compensation and Leadership Development",
    ];
    for (const q of qualifiers) {
      const re = new RegExp(`\\b${q.replace(/ /g, "\\s+")}\\s+Compensation\\s+Committee\\b`);
      if (re.test(excerpt)) return `${q} Compensation Committee`;
    }
    if (/\bCompensation\s+Committee\b/.test(excerpt)) return "Compensation Committee";
    return null;
  }
  return null;
}

function scorePolicyCandidate(policyType: string, excerpt: string, normalizedValue: string | null): number {
  const lowered = excerpt.toLowerCase();
  let score = 0;
  if (normalizedValue !== null) score += 1;
  for (const hint of POLICY_POSITIVE_HINTS[policyType] ?? []) {
    if (lowered.includes(hint)) score += 1.25;
  }
  for (const hint of POLICY_NEGATIVE_HINTS[policyType] ?? []) {
    if (lowered.includes(hint)) score -= 2.0;
  }
  if (policyType === "change_in_control" && normalizedValue === "none") score += 2.0;
  if ((policyType === "hedging" || policyType === "pledging") && normalizedValue === "prohibited") score += 1.5;
  if (policyType === "stock_ownership_guidelines" && lowered.includes("maintain")) score += 0.75;
  if (policyType === "compensation_consultant" && lowered.includes("independent")) score += 1.0;
  return score;
}

function scoreMetricCandidate(metricNorm: string, excerpt: string, observedValue: string | null): number {
  const lowered = excerpt.toLowerCase();
  let score = 0;
  const kind = valueKind(observedValue);
  if (observedValue !== null) score += 1;

  if (metricNorm === "revenue" || metricNorm === "operating_income") {
    if (kind === "currency") score += 3.2;
    else if (kind === "percent") score -= 0.75;
  } else if (metricNorm === "say_on_pay") {
    if (kind === "percent") score += 3.0;
  } else if (metricNorm === "relative_tsr") {
    if (kind === "percentile") score += 3.0;
    else if (kind === "percent") score += 0.75;
  } else if (metricNorm === "tsr") {
    if (kind === "percent") score += 2.8;
    else if (kind === "percentile") score += 1.5;
  } else if (metricNorm === "annual_incentive_payout" && kind === "percent") {
    score += 1.4;
  } else if (
    (metricNorm === "performance_rsu_vesting" ||
      metricNorm === "performance_equity_mix" ||
      metricNorm === "time_equity_mix") &&
    kind === "percent"
  ) {
    score += 1.6;
  }

  for (const hint of METRIC_POSITIVE_HINTS[metricNorm] ?? []) {
    if (lowered.includes(hint)) score += 1.1;
  }
  for (const hint of METRIC_NEGATIVE_HINTS[metricNorm] ?? []) {
    if (lowered.includes(hint)) score -= 2.25;
  }

  if (metricNorm === "revenue") {
    if (lowered.includes("minimum revenue")) score -= 3.0;
    if (lowered.includes("cloud revenue")) score -= 1.8;
  }
  if (metricNorm === "say_on_pay" && lowered.includes("say on frequency")) score -= 3.0;
  if (metricNorm === "tsr") {
    if (lowered.includes("cumulative total shareholder return")) score += 0.8;
    if (lowered.includes("relative tsr") || lowered.includes("relative total shareholder return")) score -= 1.75;
    if (lowered.includes("relative") && kind === "percent") score -= 2.4;
  }

  return score;
}

function extractFinancialTableValue(segment: string, metricNorm: string): string | null {
  const labels: { name: string; index: number }[] = [];
  for (const { name, pattern } of FINANCIAL_TABLE_LABELS) {
    const m = pattern.exec(segment);
    if (m !== null) labels.push({ name, index: m.index });
  }
  const valueMatches = findAll(segment, CURRENCY_VALUE);
  if (labels.length < 2 || valueMatches.length < 2) return null;
  labels.sort((a, b) => a.index - b.index);
  if (labels[labels.length - 1].index > valueMatches[0].index) return null;
  const orderedLabels = labels.map((l) => l.name);
  if (!orderedLabels.includes(metricNorm)) return null;
  const metricIndex = orderedLabels.indexOf(metricNorm);
  if (metricIndex >= valueMatches.length) return null;
  return cleanValue(valueMatches[metricIndex][0]);
}

function extractValue(text: string, start: number, end: number, metricNorm: string): string | null {
  const lookbehind = 160;
  const lookahead = metricNorm === "annual_incentive_payout" ? 120 : 700;
  const postMetric = collapseWs(text.slice(end, end + lookahead));
  const preMetric = collapseWs(text.slice(Math.max(0, start - lookbehind), start));
  const localWindow = collapseWs(text.slice(Math.max(0, start - lookbehind), Math.min(text.length, end + lookahead)));

  if (metricNorm === "revenue" || metricNorm === "operating_income") {
    const tableValue = extractFinancialTableValue(localWindow, metricNorm);
    if (tableValue !== null) return tableValue;
  }

  const segments = metricNorm === "say_on_pay"
    ? [localWindow, postMetric, preMetric]
    : [postMetric, localWindow, preMetric];
  const patterns = METRIC_VALUE_PATTERNS[metricNorm] ?? DEFAULT_VALUE_PATTERNS;
  for (const segment of segments) {
    for (const pattern of patterns) {
      const m = searchOnce(segment, pattern);
      if (m !== null) return cleanValue(m[0]);
    }
  }
  return null;
}

// ── Policy + metric extraction loops ─────────────────────────────────

function policyCandidate(text: string, start: number, end: number, policyType: string): PolicyCandidate {
  let excerpt = policyExcerpt(text, start, end);
  excerpt = trimPolicyExcerpt(policyType, excerpt);
  const normalized = normalizePolicyValue(policyType, excerpt);
  const score = scorePolicyCandidate(policyType, excerpt, normalized);
  return { excerpt, normalized_value: normalized, score };
}

function bestPolicyCandidate(text: string, matches: RegExpExecArray[], policyType: string): PolicyCandidate {
  const candidates = matches.map((m) => policyCandidate(text, m.index, m.index + m[0].length, policyType));
  return candidates.reduce((best, cur) => {
    if (cur.score !== best.score) return cur.score > best.score ? cur : best;
    const curHasValue = cur.normalized_value !== null;
    const bestHasValue = best.normalized_value !== null;
    if (curHasValue !== bestHasValue) return curHasValue ? cur : best;
    return -cur.excerpt.length > -best.excerpt.length ? cur : best;
  });
}

function metricCandidate(text: string, start: number, end: number, metricNorm: string): MetricCandidate {
  const excerpt = metricExcerpt(text, start, end, metricNorm);
  const observed = extractValue(text, start, end, metricNorm);
  const score = scoreMetricCandidate(metricNorm, excerpt, observed);
  return { excerpt, observed_value: observed, score };
}

function bestMetricCandidate(text: string, matches: RegExpExecArray[], metricNorm: string): MetricCandidate {
  const candidates = matches.map((m) => metricCandidate(text, m.index, m.index + m[0].length, metricNorm));
  return candidates.reduce((best, cur) => {
    if (cur.score !== best.score) return cur.score > best.score ? cur : best;
    const curHasValue = cur.observed_value !== null;
    const bestHasValue = best.observed_value !== null;
    if (curHasValue !== bestHasValue) return curHasValue ? cur : best;
    const curLen = (cur.observed_value ?? "").length;
    const bestLen = (best.observed_value ?? "").length;
    if (curLen !== bestLen) return curLen > bestLen ? cur : best;
    return -cur.excerpt.length > -best.excerpt.length ? cur : best;
  });
}

function specialEquityMixCandidate(text: string, metricNorm: string): MetricCandidate | null {
  const m = searchOnce(text, MSFT_OTHER_NEO_PATTERN);
  if (m !== null && m.groups?.value) {
    const excerpt = metricExcerpt(text, m.index, m.index + m[0].length, metricNorm);
    const performanceMix = Number.parseFloat(m.groups.value);
    if (metricNorm === "performance_equity_mix") {
      return { excerpt, observed_value: `${Math.round(performanceMix)}%`, score: 100.0 };
    }
    if (metricNorm === "time_equity_mix" && performanceMix >= 0 && performanceMix <= 100) {
      const inferred = 100 - performanceMix;
      return { excerpt, observed_value: `${Math.round(inferred)}%`, score: 99.0 };
    }
  }

  if (metricNorm === "time_equity_mix") {
    const rsuOnly = searchOnce(text, RSU_ONLY_PATTERN);
    if (rsuOnly !== null && searchOnce(text, PERFORMANCE_BASED_AWARD_PATTERN) === null) {
      const excerpt = metricExcerpt(text, rsuOnly.index, rsuOnly.index + rsuOnly[0].length, metricNorm);
      return { excerpt, observed_value: "100%", score: 98.0 };
    }
  }

  const sf = searchOnce(text, SALESFORCE_MIX_PATTERN);
  if (sf !== null && sf.groups?.value) {
    const excerpt = metricExcerpt(text, sf.index, sf.index + sf[0].length, metricNorm);
    const performanceMix = Number.parseFloat(sf.groups.value);
    if (metricNorm === "performance_equity_mix") {
      return { excerpt, observed_value: `${Math.round(performanceMix)}%`, score: 100.0 };
    }
    if (metricNorm === "time_equity_mix" && performanceMix >= 0 && performanceMix <= 100) {
      const inferred = 100 - performanceMix;
      return { excerpt, observed_value: `${Math.round(inferred)}%`, score: 99.0 };
    }
  }

  return null;
}

function normalizeSpecialMetricValue(metricNorm: string, value: string, excerpt: string): string {
  const cleaned = cleanValue(value);
  const lowered = excerpt.toLowerCase();
  if (metricNorm === "annual_incentive_payout") {
    if (lowered.includes("company performance percentage")) return `${cleaned} company performance`;
    if (lowered.includes("bonus payouts equal to") && cleaned.includes("%") && !cleaned.toLowerCase().includes("of target")) {
      return `${cleaned} of target`;
    }
    if (lowered.includes("weighted payout") && cleaned.includes("%") && !cleaned.toLowerCase().includes("of target")) {
      return `${cleaned} of target`;
    }
    if (lowered.includes("overall bonus") && cleaned.includes("%") && !cleaned.toLowerCase().includes("bonus")) {
      return `${cleaned} overall bonus`;
    }
    if (cleaned.toLowerCase() === "no bonus payment" || (cleaned.includes("$0") && lowered.includes("bonus"))) {
      return "no payout";
    }
  }
  return cleaned;
}

function specialMetricCandidate(text: string, metricNorm: string): MetricCandidate | null {
  const equityMix = specialEquityMixCandidate(text, metricNorm);
  if (equityMix !== null) return equityMix;
  const patterns = SPECIAL_METRIC_PATTERNS[metricNorm] ?? [];
  for (const pattern of patterns) {
    const m = searchOnce(text, pattern);
    if (m === null) continue;
    const excerpt = metricExcerpt(text, m.index, m.index + m[0].length, metricNorm);
    return {
      excerpt,
      observed_value: normalizeSpecialMetricValue(metricNorm, m.groups?.value ?? m[0], excerpt),
      score: 100.0,
    };
  }
  return null;
}

function shouldKeepMetricCandidate(metricNorm: string, candidate: MetricCandidate): boolean {
  const lowered = candidate.excerpt.toLowerCase();
  if (metricNorm === "annual_incentive_payout") {
    if (candidate.observed_value === null) return false;
    if (lowered.includes("target bonus opportunit") && !lowered.includes("bonus payouts equal to")) return false;
    if (lowered.includes("cash bonus opportunity") && !lowered.includes("no bonus payment")) return false;
    if (lowered.includes("multiplied by") && !lowered.includes("no bonus payment")) return false;
    return true;
  }
  if (metricNorm === "relative_tsr") {
    if (candidate.observed_value === null) return false;
    const positive = [
      "was at the", "based on this result",
      "achieving a relative total shareholder return at the",
      "our tsr relative to", "our tsr for the",
      "relative total shareholder return modifier payout",
    ];
    if (positive.some((p) => lowered.includes(p))) return true;
    const negative = [
      "must be above", "at or above the", "require outperformance",
      "to earn target payouts", "performance levels and payout scales",
      "open performance periods", "may be earned",
      "will be determined following the end",
    ];
    if (negative.some((p) => lowered.includes(p))) return false;
    return false;
  }
  if (metricNorm !== "performance_rsu_vesting") return true;
  if (candidate.observed_value === null) return false;
  return [
    "vested in", "vested on", "vested upon",
    "earned prsu shares vested",
    "maximum number of performance-based rsus", "maximum vesting",
  ].some((p) => lowered.includes(p));
}

function oneLine(excerpt: string): string {
  return collapseWs(excerpt).slice(0, 280);
}

// ── Public API (mirror fact_extractor.py:552-611) ────────────────────

export function extractFactsFromCda(
  filingId: string,
  cdaText: string,
): {
  policies: Omit<PolicyFactRow, "id" | "section_id">[];
  metrics: Omit<MetricFactRow, "id" | "section_id">[];
} {
  const policies: Omit<PolicyFactRow, "id" | "section_id">[] = [];
  const metrics: Omit<MetricFactRow, "id" | "section_id">[] = [];
  const seenPolicies = new Set<string>();
  const seenMetrics = new Set<string>();

  for (const rule of POLICY_RULES) {
    if (seenPolicies.has(rule.policyType)) continue;
    const matches = findAll(cdaText, rule.pattern);
    if (matches.length === 0) continue;
    const candidate = bestPolicyCandidate(cdaText, matches, rule.policyType);
    policies.push({
      filing_id: filingId,
      policy_type: rule.policyType,
      normalized_value: candidate.normalized_value,
      summary: oneLine(candidate.excerpt),
      source_excerpt: candidate.excerpt,
      confidence_score: rule.confidence,
      ...stamp(),
    });
    seenPolicies.add(rule.policyType);
  }

  for (const rule of METRIC_RULES) {
    if (seenMetrics.has(rule.normalized)) continue;
    let candidate = specialMetricCandidate(cdaText, rule.normalized);
    if (candidate === null) {
      // Python skips the generic fallback for tsr — only special patterns.
      if (rule.normalized === "tsr") continue;
      const matches = findAll(cdaText, rule.pattern);
      if (matches.length === 0) continue;
      candidate = bestMetricCandidate(cdaText, matches, rule.normalized);
    }
    if (!shouldKeepMetricCandidate(rule.normalized, candidate)) continue;
    metrics.push({
      filing_id: filingId,
      metric_name_raw: rule.raw,
      metric_name_normalized: rule.normalized,
      metric_category: rule.category,
      plan_type: rule.planType,
      observed_value: candidate.observed_value,
      source_excerpt: candidate.excerpt,
      confidence_score: rule.confidence,
      ...stamp(),
    });
    seenMetrics.add(rule.normalized);
  }

  return { policies, metrics };
}
