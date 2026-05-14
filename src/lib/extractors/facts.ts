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
  // Compensation committee — name varies. Two common shapes:
  //  - "[Qualifier] Compensation Committee" (e.g. "People and
  //    Compensation Committee", "Leadership Development and
  //    Compensation Committee")
  //  - "Compensation, [extra responsibilities] Committee" (e.g.
  //    "Compensation, Nominating & Governance Committee" — META).
  {
    // Case-insensitive so the ALL-CAPS section heading variant
    // (Home Depot: "LEADERSHIP DEVELOPMENT AND COMPENSATION
    // COMMITTEE REPORT") matches alongside the standard Title-Case
    // body-text form. Normalization in `normalizePolicyValue` returns
    // the canonical Title-Case name either way.
    policyType: "compensation_committee",
    pattern:
      /\b(?:[A-Z][a-z]+\s+(?:and\s+[A-Z][a-z]+\s+)?(?:and\s+)?)?Compensation(?:[,&\s]+(?:and\s+)?[A-Z][a-zA-Z]+){0,4}\s+Committee\b/i,
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
  { raw: "Median Employee Compensation", normalized: "median_employee_compensation", category: "pay_ratio", planType: null, pattern: /\bmedian\s+(?:compensated\s+|annual\s+|hourly\s+)?(?:employee|associate|worker|teammate)\b/i, confidence: 0.9 },
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
    // "Ratio of [CEO] to [Median Employee] (annual) total compensation
    // [optional verb] N:1" — canonical Item 402(u) phrasing.
    // Permissive [^.]{0,200}? filler between anchors so we tolerate
    // "annual total compensation of our CEO" / "co-CEOs'" / "Mr. X's"
    // wording. Verb is optional because GOOGL emits a table-header form
    // ("Ratio of Chief Executive Officer to Median Employee total
    // compensation 808:1") with no "was/is".
    /\bratio\s+of\s+(?:the\s+|our\s+)?(?:[^.]{0,200}?)?(?:chief\s+executive\s+officer|ceos?)['’\s]*(?:[^.]{0,200}?)?\bto\s+(?:the\s+|our\s+)?(?:[^.]{0,200}?)?median(?:\s+(?:compensated\s+)?employee)?(?:'s|’s)?(?:[^.]{0,200}?)?(?:\s+(?:was|is)\s+(?:approximately\s+)?)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/is,
    // "[fiscal year YYYY|YYYY] pay ratio [verb] N:1" — year-anchored.
    // Preferred over generic "pay ratio of N:1" so we don't latch onto
    // historical comparison sentences ("our 2020 pay ratio was 27:1").
    /\b(?:fiscal\s+(?:year\s+)?)?20\d{2}\s+pay\s+ratio\s+(?:was|is)\s+(?:approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // "ratio of these/those amounts is N to 1" — Apple/Adobe-style
    // shorthand where the section's earlier sentences already named
    // the CEO and median employee values.
    /\bratio\s+of\s+(?:these|those)\s+amounts\s+(?:is|was|of)\s+(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // Reversed ratio form: "ratio of those amounts of 1-to-43" (AMZN
    // 2023-2025). The non-1 side is the actual CEO:median multiplier;
    // normalizePayRatio() flips it back to canonical "N to 1".
    /\bratio\s+of\s+(?:these|those)\s+amounts\s+of\s+(?<value>1\s*(?:-\s*to\s*-?\s*|\s*to\s+|:)\s*\d{1,5}(?:\.\d+)?|\d{1,5}(?:\.\d+)?\s*(?:-\s*to\s*-?\s*|\s*to\s+|:)\s*1)\b/i,
    // "Ratio calculated in accordance with Item 402(u) ... is N to 1"
    // (AVGO, ORCL — section-level "the Ratio" with no CEO/median anchor
    // because the surrounding paragraphs already named the values).
    /\b(?:the\s+)?ratio\s+(?:calculated[^.]{0,150}?|set\s+forth\s+above|reported\s+above)?\s*(?:was|is)\s+(?:approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // "the resulting ratio was N : 1" (QCOM).
    /\b(?:the\s+)?resulting\s+ratio\s+(?:was|is)\s+(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // "resulted in a ratio of N to 1" (ADBE) — short closing sentence
    // form where the ratio is the direct object of the verb. Requires
    // the verb so it doesn't accidentally pull in "peer group ratio of
    // 50/50" or similar non-pay-ratio language.
    /\b(?:resulted|results|resulting)\s+in\s+(?:a\s+)?ratio\s+of\s+(?:approximately\s+|those\s+amounts\s+of\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // "CEO Pay Ratio is estimated to be N to 1" / "estimated at N to 1"
    // (AYI / industrials — methodology-heavy disclosures defer the
    // value to the closing sentence).
    /\b(?:ceo\s+)?pay\s+ratio\s+(?:for\s+(?:fiscal\s+)?20\d{2}\s+)?(?:is|was)\s+(?:estimated\s+(?:to\s+be|at)\s+|approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    /\bestimated\s+to\s+be\s+(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/i,
    // Fallback: "pay ratio is N:1" with no year qualifier.
    /\bpay\s+ratio\s+(?:of\s+|was\s+|is\s+)(?:approximately\s+)?(?<value>\d{1,5}(?:\.\d+)?\s*(?:\s*to\s*|:|-\s*)\s*1)\b/is,
  ],
  median_employee_compensation: [
    // "Median Employee total compensation in YYYY $X" (GOOGL).
    /\bmedian\s+(?:compensated\s+|annual\s+|hourly\s+)?(?:employee|associate|worker|teammate)(?:'s|’s)?\s+(?:annual\s+)?total(?:\s+annual)?\s+compensation\s+(?:in\s+20\d{2}\s+)?(?:was\s+|is\s+|of\s+)?(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
    // "annual total compensation of our median (compensated) employee
    // [verb] $X" (Item 402(u) canonical phrasing).
    /\bannual\s+total\s+compensation\s+of\s+(?:the\s+|our\s+)?median\s+(?:compensated\s+|annual\s+|hourly\s+)?(?:employee|associate|worker|teammate)\s+(?:was|is)\s+(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
    // "annual total compensation FOR the median employee … was $X"
    // (MSFT — preposition is "for" not "of"; rest of the sentence may
    // qualify with "other than our CEO" before the verb).
    /\bannual\s+total\s+compensation\s+for\s+(?:the\s+|our\s+)?median\s+(?:compensated\s+|annual\s+|hourly\s+)?(?:employee|associate|worker|teammate)\b(?:[^.]{0,150}?)\s+(?:was|is)\s+(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
    // "median of the annual total compensation of all employees …
    // was $X" (META variant — phrasing reversed but the value is the
    // median employee comp). The qualifier permits AYI-style
    // "all of the Company's associates" and AVGO-style "all our
    // employees". Workforce-term variants (employees, associates,
    // workers, teammates) cover the long-tail cohort. Filler uses
    // [\s\S] with a short cap so it tolerates abbreviations like
    // "Mr. Ashe" (which break a [^.] filler) while still bounding
    // the match to the same sentence.
    /\bmedian\s+of\s+the\s+(?:annual\s+)?total\s+compensation\s+of\s+all\s+(?:of\s+(?:the\s+(?:Company'?s\s+)?)?)?(?:our\s+|other\s+|the\s+Company'?s\s+)?(?:employees|associates|workers|teammates)(?:[\s\S]{0,80}?)\s+(?:was|is)\s+(?<value>\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?)/is,
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

/**
 * Per-fact provenance stamp. `sourceSection` is encoded into
 * `extraction_method` so downstream UI can label whether a fact came
 * from CD&A, the Item 402(u) pay-ratio section, the say-on-pay
 * proposal, or the Item 407(e)(5) committee report.
 */
function stamp(sourceSection: string = "cd_and_a") {
  const suffix = sourceSection === "cd_and_a" ? "" : `:${sourceSection}`;
  return {
    extractor_version: FACT_EXTRACTOR_VERSION,
    extraction_method: `regex-fact-rule${suffix}`,
    source_document_name: null,
    source_document_sha: null,
    verification_status: "machine_extracted" as const,
    review_status: "unreviewed" as const,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
  };
}

/**
 * Parse `extraction_method` back into a section type. Returns the
 * section that produced this fact, or "cd_and_a" if it was extracted
 * from CD&A (the historical default).
 */
export function factSourceSection(extractionMethod: string | null): string {
  if (!extractionMethod) return "cd_and_a";
  const colon = extractionMethod.indexOf(":");
  if (colon === -1) return "cd_and_a";
  return extractionMethod.slice(colon + 1);
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
      "Leadership Development, Inclusion and",
      "Leadership Development and",
      "Human Resources and",
      "Human Capital and",
      "Management Development and",
      "Talent Development and",
      "People and",
      "Talent and",
      "Personnel and",
      "Executive",
      "HR and",
      "Compensation and Talent",
      "Compensation and Leadership Development",
    ];
    for (const q of qualifiers) {
      // Case-insensitive so an all-caps section header like
      // "LEADERSHIP DEVELOPMENT AND COMPENSATION COMMITTEE" (Home Depot)
      // still resolves to the canonical Title-Case name.
      const re = new RegExp(`\\b${q.replace(/[ ,]/g, "[ ,]+")}\\s+Compensation\\s+Committee\\b`, "i");
      if (re.test(excerpt)) return `${q} Compensation Committee`;
    }
    // Compensation-first hybrids: "Compensation, Nominating & Governance
    // Committee" (META) and similar shapes where Compensation is the
    // first responsibility, followed by adjacent ones. Capture exactly
    // the words between "Compensation" and "Committee".
    const compFirst = excerpt.match(
      /\bCompensation((?:[,&\s]+(?:and\s+)?[A-Z][a-zA-Z]+){1,4})\s+Committee\b/,
    );
    if (compFirst) {
      const tail = compFirst[1].replace(/\s+/g, " ").trim();
      // Reject captures whose intermediate words read like a section
      // header (e.g. "Compensation Risk Assessment The Committee" from
      // a "Compensation Risk Considerations" subsection) rather than a
      // real committee name. Real committee qualifiers come from a
      // small vocabulary of corporate functions; anything outside it
      // collapses to canonical "Compensation Committee".
      const REJECT_TOKENS = new Set([
        "Risk",
        "Assessment",
        "Considerations",
        "Recoupment",
        "Recovery",
        "Audit",
        "Report",
        "Charter",
        "Process",
        "Discussion",
        "Analysis",
        "Disclosure",
        "Policy",
        "Practices",
        "Program",
        "Plan",
        "Plans",
        "Decision",
        "Decisions",
        "Determination",
        "Determinations",
        "Approval",
        "Review",
        // ZTS exposed: "the Compensation Consultant. The Human Resources
        // and Compensation Committee" was greedily captured as one
        // committee name "Compensation Consultant The Human Resources
        // and Compensation Committee" because "Consultant" + "The" both
        // satisfied the Title-Case token pattern.
        "Consultant",
        "Consultants",
        "The",
      ]);
      const tokens = tail.split(/[\s,&]+/).filter(Boolean);
      const hasReject = tokens.some((t) => REJECT_TOKENS.has(t));
      if (!hasReject) {
        return `Compensation${tail.startsWith(",") ? tail : ` ${tail}`} Committee`;
      }
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
  if (metricNorm === "ceo_pay_ratio") {
    return normalizePayRatio(cleaned);
  }
  return cleaned;
}

/**
 * Canonicalize a pay-ratio expression to "N to 1" form.
 *  - "43 to 1"        → "43 to 1"  (already canonical)
 *  - "43:1"           → "43 to 1"  (colon → "to")
 *  - "1-to-43"        → "43 to 1"  (reversed Amazon-style form)
 *  - "1 to 43"        → "43 to 1"  (reversed)
 *  - "1.5 to 1"       → "1.5 to 1" (fractional CEO:median; rare but legal)
 */
function normalizePayRatio(value: string): string {
  const m = value.match(/^(?<a>\d+(?:\.\d+)?)\s*(?:-\s*to\s*-?\s*|\s*to\s+|\s*:\s*|\s*-\s*)(?<b>\d+(?:\.\d+)?)$/);
  if (!m || !m.groups) return value;
  const a = Number.parseFloat(m.groups.a);
  const b = Number.parseFloat(m.groups.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return value;
  if (b === 1) return `${formatRatioNumber(a)} to 1`;
  if (a === 1) return `${formatRatioNumber(b)} to 1`;
  return value.replace(/[:\-]/g, " to ").replace(/\s+/g, " ").trim();
}

function formatRatioNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
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

/**
 * Run fact extraction over a single section text.
 *
 * `allowedPolicies` / `allowedMetrics` restrict which rules can fire,
 * so scoped sections (pay-ratio section, committee report) only look
 * for facts they're plausibly the source for. Pass `null` to allow
 * every rule (the historical CD&A behavior).
 */
function extractFactsForSection(
  filingId: string,
  text: string,
  sourceSection: string,
  allowedPolicies: Set<string> | null,
  allowedMetrics: Set<string> | null,
): {
  policies: Omit<PolicyFactRow, "id" | "section_id">[];
  metrics: Omit<MetricFactRow, "id" | "section_id">[];
} {
  const policies: Omit<PolicyFactRow, "id" | "section_id">[] = [];
  const metrics: Omit<MetricFactRow, "id" | "section_id">[] = [];
  const seenPolicies = new Set<string>();
  const seenMetrics = new Set<string>();

  for (const rule of POLICY_RULES) {
    if (allowedPolicies && !allowedPolicies.has(rule.policyType)) continue;
    if (seenPolicies.has(rule.policyType)) continue;
    const matches = findAll(text, rule.pattern);
    if (matches.length === 0) continue;
    const candidate = bestPolicyCandidate(text, matches, rule.policyType);
    policies.push({
      filing_id: filingId,
      policy_type: rule.policyType,
      normalized_value: candidate.normalized_value,
      summary: oneLine(candidate.excerpt),
      source_excerpt: candidate.excerpt,
      confidence_score: rule.confidence,
      ...stamp(sourceSection),
    });
    seenPolicies.add(rule.policyType);
  }

  for (const rule of METRIC_RULES) {
    if (allowedMetrics && !allowedMetrics.has(rule.normalized)) continue;
    if (seenMetrics.has(rule.normalized)) continue;
    let candidate = specialMetricCandidate(text, rule.normalized);
    if (candidate === null) {
      // Python skips the generic fallback for tsr — only special patterns.
      if (rule.normalized === "tsr") continue;
      const matches = findAll(text, rule.pattern);
      if (matches.length === 0) continue;
      candidate = bestMetricCandidate(text, matches, rule.normalized);
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
      ...stamp(sourceSection),
    });
    seenMetrics.add(rule.normalized);
  }

  return { policies, metrics };
}

export function extractFactsFromCda(
  filingId: string,
  cdaText: string,
): {
  policies: Omit<PolicyFactRow, "id" | "section_id">[];
  metrics: Omit<MetricFactRow, "id" | "section_id">[];
} {
  return extractFactsForSection(filingId, cdaText, "cd_and_a", null, null);
}

/**
 * Rule scoping per non-CD&A section. Each entry lists the policy /
 * metric types that can be plausibly extracted from that section's
 * text. Rules outside this list are ignored to avoid surfacing
 * spurious matches (e.g., "compensation consultant" appears in nearly
 * every committee report header).
 */
const SECTION_RULE_SCOPE: Record<
  string,
  { policies: Set<string>; metrics: Set<string> }
> = {
  ceo_pay_ratio: {
    policies: new Set<string>(),
    metrics: new Set(["ceo_pay_ratio", "median_employee_compensation"]),
  },
  say_on_pay: {
    policies: new Set<string>(),
    metrics: new Set(["say_on_pay"]),
  },
  compensation_committee_report: {
    policies: new Set(["compensation_committee"]),
    metrics: new Set<string>(),
  },
};

export interface SectionInput {
  section_type: string;
  text: string;
  /**
   * Optional section heading text. When provided, prepended to the
   * section text for scanning so a fact carried only in the heading
   * (e.g. WMT's "Compensation Committee Report" heading while the body
   * uses the "CMDC" acronym) still surfaces. Doesn't affect
   * source_excerpt content meaningfully — the heading is short.
   */
  heading?: string | null;
}

/**
 * Run fact extraction over all sections that we have for a filing.
 * CD&A is the primary source (all rules). For each fact CD&A didn't
 * surface, fall back to the dedicated section (Item 402(u) for pay
 * ratio, the say-on-pay proposal for that vote, the Item 407(e)(5)
 * committee report for the committee name).
 *
 * Each fact's `extraction_method` records the section it came from
 * (`regex-fact-rule` for CD&A, `regex-fact-rule:ceo_pay_ratio` etc.).
 * `factSourceSection()` parses that back into the section type for UI
 * surfacing.
 */
export function extractFactsFromSections(
  filingId: string,
  sections: SectionInput[],
): {
  policies: Omit<PolicyFactRow, "id" | "section_id">[];
  metrics: Omit<MetricFactRow, "id" | "section_id">[];
} {
  const cda = sections.find((s) => s.section_type === "cd_and_a");
  const policies: Omit<PolicyFactRow, "id" | "section_id">[] = [];
  const metrics: Omit<MetricFactRow, "id" | "section_id">[] = [];
  const seenPolicyTypes = new Set<string>();
  const seenMetricNames = new Set<string>();

  function textWithHeading(s: SectionInput): string {
    return s.heading ? `${s.heading}\n\n${s.text}` : s.text;
  }

  // Helpers — a policy/metric is "satisfied" only when it produced a
  // non-null normalized/observed value. A CD&A match that fell through
  // normalization (e.g. HD's CD&A body mentions "LDC Committee" but the
  // dedicated committee_report section carries the full
  // "Leadership Development and Compensation Committee" name) must NOT
  // block the dedicated section from re-trying.
  const satisfiedPolicies = new Set<string>();
  const satisfiedMetrics = new Set<string>();
  const policyByType = new Map<
    string,
    Omit<PolicyFactRow, "id" | "section_id">
  >();
  const metricByName = new Map<
    string,
    Omit<MetricFactRow, "id" | "section_id">
  >();

  if (cda) {
    const cdaResult = extractFactsForSection(filingId, textWithHeading(cda), "cd_and_a", null, null);
    for (const p of cdaResult.policies) {
      policies.push(p);
      seenPolicyTypes.add(p.policy_type);
      policyByType.set(p.policy_type, p);
      if (p.normalized_value !== null) satisfiedPolicies.add(p.policy_type);
    }
    for (const m of cdaResult.metrics) {
      metrics.push(m);
      if (m.metric_name_normalized) {
        seenMetricNames.add(m.metric_name_normalized);
        metricByName.set(m.metric_name_normalized, m);
        if (m.observed_value !== null) satisfiedMetrics.add(m.metric_name_normalized);
      }
    }
  }

  for (const section of sections) {
    if (section.section_type === "cd_and_a") continue;
    const scope = SECTION_RULE_SCOPE[section.section_type];
    if (!scope) continue;
    // Re-scan a rule if CD&A produced no value for it (normalized null).
    // Don't re-scan rules CD&A already SATISFIED (non-null value).
    const remainingPolicies = new Set(
      [...scope.policies].filter((p) => !satisfiedPolicies.has(p)),
    );
    const remainingMetrics = new Set(
      [...scope.metrics].filter((m) => !satisfiedMetrics.has(m)),
    );
    if (remainingPolicies.size === 0 && remainingMetrics.size === 0) continue;

    const sectionResult = extractFactsForSection(
      filingId,
      textWithHeading(section),
      section.section_type,
      remainingPolicies,
      remainingMetrics,
    );
    for (const p of sectionResult.policies) {
      if (p.normalized_value === null) continue;
      const prior = policyByType.get(p.policy_type);
      if (prior && prior.normalized_value !== null) continue;
      if (prior) {
        // Replace the prior null-valued CD&A row in `policies` with
        // the dedicated section's resolved value. The unreviewed
        // duplicate-row check on the DB write path stays correct
        // because we only insert one row per (filing_id, policy_type).
        const idx = policies.indexOf(prior);
        if (idx >= 0) policies[idx] = p;
        else policies.push(p);
      } else {
        policies.push(p);
        seenPolicyTypes.add(p.policy_type);
      }
      policyByType.set(p.policy_type, p);
      satisfiedPolicies.add(p.policy_type);
    }
    for (const m of sectionResult.metrics) {
      const name = m.metric_name_normalized;
      if (!name || m.observed_value === null) continue;
      const prior = metricByName.get(name);
      if (prior && prior.observed_value !== null) continue;
      if (prior) {
        const idx = metrics.indexOf(prior);
        if (idx >= 0) metrics[idx] = m;
        else metrics.push(m);
      } else {
        metrics.push(m);
        seenMetricNames.add(name);
      }
      metricByName.set(name, m);
      satisfiedMetrics.add(name);
    }
  }

  return { policies, metrics };
}
