/**
 * Section extractors for proxy disclosures that live OUTSIDE the
 * Compensation Discussion & Analysis section. Several material facts
 * — CEO pay ratio (Item 402(u)), the Compensation Committee Report
 * (Item 407(e)(5)), and the Say-on-Pay advisory vote — are commonly
 * filed alongside CD&A but in their own subsections. ProxyMiner used
 * to ignore those sections, which meant Apple/Microsoft/Netflix-style
 * filings dropped pay-ratio coverage entirely.
 *
 * Each extractor returns a section row keyed by its own `section_type`.
 * The fact extractor (facts.ts) then runs scoped patterns on the
 * captured text so that pay-ratio + median + committee values land in
 * Postgres regardless of where the company filed them.
 *
 * Heading anchors are intentionally permissive: pay-ratio headings
 * vary widely (`Pay Ratio Disclosure`, `CEO Pay Ratio`, `Item 402(u)`,
 * `Pay Ratio—2025`, `<Company> CEO Pay Ratio`). The match predicate
 * normalizes whitespace + dashes and accepts any heading whose core
 * phrase matches, with no other long content surrounding it.
 */
import {
  extractSection,
  fullMatch,
  loadHtml,
  normalizedText,
  type ExtractedSection,
} from "./section-helpers";
import type { CheerioAPI } from "cheerio";

export const PAY_RATIO_EXTRACTOR_VERSION = "pay_ratio_section_extractor.ts.v1";
export const SAY_ON_PAY_EXTRACTOR_VERSION = "say_on_pay_section_extractor.ts.v1";
export const COMP_COMMITTEE_REPORT_EXTRACTOR_VERSION =
  "comp_committee_report_section_extractor.ts.v1";

export type ProxySectionType =
  | "ceo_pay_ratio"
  | "say_on_pay"
  | "compensation_committee_report";

export interface ProxySectionResult {
  section_type: ProxySectionType;
  section: ExtractedSection;
  extractor_version: string;
}

// ── Pay Ratio (Item 402(u)) ───────────────────────────────────────────
//
// Headings observed in the pilot cohort:
//   - "CEO Pay Ratio"             (MSFT)
//   - "CEO Pay Ratio—2025"        (AAPL — em-dash year suffix)
//   - "Alphabet CEO Pay Ratio"    (GOOGL — company prefix)
//   - "Pay Ratio Disclosure"      (NFLX)
//   - "Pay Ratio"                 (some smaller filers)
//   - "Item 402(u) — Pay Ratio Disclosure"
//   - "Fiscal 2025 CEO Pay Ratio" (CRM — fiscal-year prefix)
// Tolerates an extended prefix (HBAN: "Executive Compensation Tables:
// Pay Ratio Disclosure") and a "Disclosure" suffix split by an
// inadvertent space (HBAN's "Discl osure" rendering artifact, where
// the PDF→HTML transformer broke the word across a glyph boundary).
const PAY_RATIO_PATTERN =
  /^(?:item\s+402\(u\)\s*[-–—:]?\s*)?(?:(?:fiscal\s+(?:year\s+)?)?20\d{2}\s+)?(?:[a-z][a-z :.,&'’–—-]{0,60}?\s+)?(?:ceo\s+)?pay\s+ratio(?:\s+discl\s?osure)?(?:\s*[-–—:]\s*(?:fiscal\s+(?:year\s+)?)?20\d{2})?$/i;

const PAY_RATIO_END_PATTERNS: RegExp[] = [
  /^pay\s+versus\s+performance$/i,
  /^pay\s+for\s+performance$/i,
  /^equity\s+compensation\s+plan(?:s|\s+information)?$/i,
  /^director\s+compensation$/i,
  /^outstanding\s+equity\s+awards.*$/i,
  /^summary\s+compensation\s+table$/i,
  /^proposal\s+(?:no\.?\s*|number\s*)?\d+/i,
  /^proposal\s+\w+/i,
  /^certain\s+relationships\s+and\s+related\s+transactions$/i,
  /^security\s+ownership/i,
];

export function extractPayRatioSection(
  $: CheerioAPI,
): ExtractedSection | null {
  return extractSection($, {
    matchesHeading: (text) => PAY_RATIO_PATTERN.test(text),
    isSectionEnd: (text, collectedChars) => {
      if (collectedChars < 600) return false;
      if (text.length > 160) return false;
      return PAY_RATIO_END_PATTERNS.some((p) => fullMatch(p, text));
    },
    methodLabel: "ceo-pay-ratio",
    // Most pay-ratio disclosures are 1-3 paragraphs of Item 402(u)
    // language, but some filers (AYI / regional banks / REITs) emit
    // multi-page methodology before the actual ratio. Cap generously
    // so the closing "estimated to be N to 1" sentence still gets
    // captured, while still bounding a missed end-pattern from
    // dragging us into "Pay Versus Performance".
    maxChars: 60_000,
    maxBlocks: 300,
    minSectionEndChars: 600,
    minSectionCharsForFallback: 400,
    flowOvershootChars: 200,
    acceptHeadingOnly: false,
  });
}

// ── Say on Pay (Advisory Vote on Executive Compensation) ─────────────
//
// Headings vary wildly across companies. Common patterns:
//   - "Advisory Vote on Executive Compensation"
//   - "Advisory (Non-Binding) Vote on Executive Compensation"
//   - "Approval, on an Advisory Basis, of Executive Compensation"
//   - "Say on Pay" / "Say-on-Pay" / "Say-on-Pay Vote"
//   - "Advisory Vote to Approve Executive/Named Executive Officer Compensation"
//   - "Proposal No. 3 — Advisory Vote on Executive Compensation"
//   - "Proposal Four: Advisory Vote on the Compensation of our Named Executive Officers"
//
// We split into two predicates so we don't accidentally swallow other
// proposals that happen to share a "Proposal N: Approval of …" prefix
// (e.g. amendments to the certificate of incorporation).
const SAY_ON_PAY_PATTERN =
  /\b(?:advisory\s+(?:[a-z()\- ]{0,30}?\s+)?vote\s+(?:on|to\s+approve)\s+(?:our\s+|the\s+)?(?:[a-z\- ]{0,40}?\s+)?(?:executive\s+|named\s+executive\s+officer\s+|neo\s+)?compensation|approval(?:\s*,\s+(?:on\s+an\s+advisory\s+basis|on\s+a\s+non[\s-]binding\s+basis))?,?\s+of\s+(?:our\s+|the\s+)?(?:named\s+executive\s+officer\s+|executive\s+|neo\s+)compensation|advisory\s+vote\s+(?:on|to\s+approve)\s+the\s+compensation\s+of\s+(?:our\s+|the\s+)?(?:named\s+executive\s+officers|executive\s+officers|neos))/i;
const SAY_ON_PAY_SHORT_PATTERN = /^(?:[a-z\- ]{0,40}?\s+)?say[\s-]?on[\s-]?pay(?:\s+vote)?(?:\s+and\s+stockholder\s+outreach)?$/i;
// Excludes proposals about the *frequency* of say-on-pay (Item 14a-21(b)),
// which describe a separate vote and shouldn't be conflated with the
// pay-vote disclosure.
const SAY_ON_PAY_FREQUENCY_PATTERN =
  /\bfrequency\s+of\s+(?:future\s+)?(?:advisory\s+vote|say[\s-]on[\s-]pay)/i;

const SAY_ON_PAY_END_PATTERNS: RegExp[] = [
  /^proposal\s+(?:no\.?\s*|number\s*)?\d+/i,
  /^approval\s+of/i,
  /^advisory\s+vote\s+on\s+the\s+frequency/i,
  /^report\s+of\s+the\s+audit\s+committee$/i,
  /^audit\s+matters$/i,
  /^certain\s+relationships\s+and\s+related\s+transactions$/i,
  /^director\s+compensation$/i,
  /^pay\s+ratio$/i,
  /^pay\s+versus\s+performance$/i,
];

export function extractSayOnPaySection(
  $: CheerioAPI,
): ExtractedSection | null {
  return extractSection($, {
    matchesHeading: (text) => {
      if (SAY_ON_PAY_FREQUENCY_PATTERN.test(text)) return false;
      return SAY_ON_PAY_SHORT_PATTERN.test(text) || SAY_ON_PAY_PATTERN.test(text);
    },
    isSectionEnd: (text, collectedChars) => {
      if (collectedChars < 400) return false;
      if (text.length > 160) return false;
      return SAY_ON_PAY_END_PATTERNS.some((p) => fullMatch(p, text));
    },
    methodLabel: "say-on-pay",
    // Bound to one proposal block. The patterns we care about — "votes
    // cast", "in favor of", "say on pay" — sit in the first ~3000 chars
    // of the proposal section. Capping here prevents drag into the
    // following proposal (e.g., Proposal 5 / Proposal Four when the
    // expected end heading isn't recognized).
    maxChars: 25_000,
    maxBlocks: 120,
    minSectionEndChars: 400,
    minSectionCharsForFallback: 300,
    flowOvershootChars: 200,
    acceptHeadingOnly: false,
  });
}

// ── Compensation Committee Report (Item 407(e)(5)) ───────────────────
//
// Required item; sits next to CD&A but is structurally a separate
// section. Two heading idioms predominate:
//   1) "<Qualifier> Compensation Committee Report"
//        - "Compensation Committee Report"
//        - "People and Compensation Committee Report"        (many tech)
//        - "Talent and Compensation Committee Report"
//        - "Human Capital Management and Compensation Committee Report"
//        - "Leadership Development, Inclusion and Compensation Committee Report"
//   2) "Report of the <Qualifier> Compensation <Qualifier> Committee"
//        - "Report of the Executive Compensation Committee"        (ADBE)
//        - "Report of the Compensation, Nominating & Governance Committee" (META)
//        - "Report of the People and Compensation Committee"
const COMP_COMMITTEE_REPORT_PATTERN =
  /^(?:(?:[a-z][a-z .,&'’\-]{0,80}\s+(?:and\s+)?)?compensation\s+committee\s+report|report\s+of\s+the\s+(?:[a-z][a-z .,&'’\-]{0,80}?\s+)?compensation(?:\s*[,&]?\s+[a-z][a-z .,&'’\-]{0,80}?)?\s+committee)$/i;

const COMP_COMMITTEE_REPORT_END_PATTERNS: RegExp[] = [
  /^pay\s+versus\s+performance$/i,
  /^summary\s+compensation\s+table$/i,
  /^grants\s+of\s+plan-based\s+awards$/i,
  /^equity\s+compensation\s+plan/i,
  /^outstanding\s+equity\s+awards.*$/i,
  /^director\s+compensation$/i,
  /^report\s+of\s+the\s+audit\s+committee$/i,
  /^audit\s+matters$/i,
];

export function extractCompCommitteeReportSection(
  $: CheerioAPI,
): ExtractedSection | null {
  return extractSection($, {
    matchesHeading: (text) => COMP_COMMITTEE_REPORT_PATTERN.test(text),
    isSectionEnd: (text, collectedChars) => {
      if (collectedChars < 200) return false;
      if (text.length > 160) return false;
      return COMP_COMMITTEE_REPORT_END_PATTERNS.some((p) => fullMatch(p, text));
    },
    methodLabel: "comp-committee-report",
    // Committee reports are short (Item 407(e)(5) — typically 2-4
    // paragraphs of "the Committee has reviewed and discussed"). Cap
    // hard so an unrecognized end-heading can't drag us into Pay
    // Versus Performance or the SCT in unusual layouts.
    maxChars: 6_000,
    maxBlocks: 40,
    minSectionEndChars: 200,
    minSectionCharsForFallback: 150,
    flowOvershootChars: 200,
    acceptHeadingOnly: false,
  });
}

/**
 * Run every proxy-section extractor against a single parsed HTML
 * document. Returns only the sections that hit (one entry per section
 * type). Callers should pre-load `$` once and pass it here so we don't
 * pay the parse cost N times.
 */
export function extractProxySections(html: string): ProxySectionResult[] {
  const $ = loadHtml(html);
  if (!$) return [];
  const results: ProxySectionResult[] = [];

  const payRatio = extractPayRatioSection($);
  if (payRatio && payRatio.text.length > 0) {
    results.push({
      section_type: "ceo_pay_ratio",
      section: payRatio,
      extractor_version: PAY_RATIO_EXTRACTOR_VERSION,
    });
  }

  const sayOnPay = extractSayOnPaySection($);
  if (sayOnPay && sayOnPay.text.length > 0) {
    results.push({
      section_type: "say_on_pay",
      section: sayOnPay,
      extractor_version: SAY_ON_PAY_EXTRACTOR_VERSION,
    });
  }

  const committeeReport = extractCompCommitteeReportSection($);
  if (committeeReport && committeeReport.text.length > 0) {
    results.push({
      section_type: "compensation_committee_report",
      section: committeeReport,
      extractor_version: COMP_COMMITTEE_REPORT_EXTRACTOR_VERSION,
    });
  }

  return results;
}

export { normalizedText };
