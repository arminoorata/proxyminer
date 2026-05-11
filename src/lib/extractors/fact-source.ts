/**
 * UI helpers for surfacing where a fact was extracted from. The fact
 * extractor encodes the source section in `extraction_method` —
 * `regex-fact-rule` for CD&A, `regex-fact-rule:<section_type>` for the
 * dedicated proxy sections. This module turns those identifiers into
 * short labels suitable for inline UI badges.
 */

/**
 * Parse `extraction_method` and return the section_type the fact came
 * from. Defaults to "cd_and_a" for the historical (un-suffixed) form.
 */
export function factSourceSection(extractionMethod: string | null | undefined): string {
  if (!extractionMethod) return "cd_and_a";
  const colon = extractionMethod.indexOf(":");
  if (colon === -1) return "cd_and_a";
  return extractionMethod.slice(colon + 1);
}

const SOURCE_LABELS: Record<string, { short: string; full: string }> = {
  cd_and_a: { short: "CD&A", full: "Compensation Discussion & Analysis" },
  ceo_pay_ratio: { short: "Item 402(u)", full: "CEO Pay Ratio section (Item 402(u))" },
  say_on_pay: { short: "Say-on-Pay", full: "Say-on-Pay advisory proposal" },
  compensation_committee_report: {
    short: "Committee Report",
    full: "Compensation Committee Report (Item 407(e)(5))",
  },
};

/**
 * Short label for inline UI surfacing. Falls back to a humanized form
 * of the section type if we haven't catalogued it.
 */
export function factSourceLabel(extractionMethod: string | null | undefined): string {
  const section = factSourceSection(extractionMethod);
  return SOURCE_LABELS[section]?.short ?? section.replace(/_/g, " ");
}

/**
 * Long-form label for hover/tooltip surfacing.
 */
export function factSourceTooltip(extractionMethod: string | null | undefined): string {
  const section = factSourceSection(extractionMethod);
  const label = SOURCE_LABELS[section]?.full ?? section.replace(/_/g, " ");
  return `Extracted from: ${label}`;
}
