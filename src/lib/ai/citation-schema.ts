import { z } from "zod";

/**
 * Structured response schema for the grounded AI assistant.
 *
 * Plan §"Suggested implementation direction" requires:
 *   - answer title, body, bullets
 *   - citations
 *   - scope note / uncertainty note
 *
 * Plan §"Non-Negotiable Principles #2" forbids the assistant from
 * returning unsupported numbers or speaking outside the loaded
 * filing/company/compare context.
 *
 * Citations bind every claim to one of:
 *   - an executive comp row (filing + executive + year + field)
 *   - a peer group / peer member
 *   - a policy fact
 *   - a metric fact
 *   - a CD&A excerpt
 *
 * The route handler validates the model output against this schema
 * and rejects (or asks for retry) if the citations don't resolve to
 * artifacts the route loaded into context. This is the runtime guard
 * against hallucinated facts.
 */

export const CitationKindEnum = z.enum([
  "executive_comp",
  "policy_fact",
  "metric_fact",
  "peer_group",
  "peer_member",
  "section_excerpt",
  "filing_metadata",
]);
export type CitationKind = z.infer<typeof CitationKindEnum>;

export const CitationSchema = z.object({
  kind: CitationKindEnum,
  filing_id: z.string(),
  // Stable natural keys for each artifact type. Sufficient to look up
  // the underlying row in the loaded context without exposing autoinc
  // IDs to the model.
  ref: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("executive_comp"),
      executive_name: z.string(),
      year: z.number().int(),
      field: z.enum([
        "salary",
        "bonus",
        "stock_awards",
        "option_awards",
        "non_equity_incentive_plan_compensation",
        "all_other_compensation",
        "total",
      ]),
    }),
    z.object({
      kind: z.literal("policy_fact"),
      policy_type: z.string(),
    }),
    z.object({
      kind: z.literal("metric_fact"),
      metric_name_normalized: z.string(),
    }),
    z.object({
      kind: z.literal("peer_group"),
      peer_group_name: z.string().optional(),
    }),
    z.object({
      kind: z.literal("peer_member"),
      peer_group_name: z.string().optional(),
      company_name_raw: z.string(),
    }),
    z.object({
      kind: z.literal("section_excerpt"),
      section_type: z.string(),
      excerpt: z.string(),
    }),
    z.object({
      kind: z.literal("filing_metadata"),
      field: z.enum([
        "form_type",
        "filing_date",
        "filing_year",
        "primary_document_url",
        "accession_number",
      ]),
    }),
  ]),
  excerpt: z.string().describe(
    "Short verbatim quote (≤300 chars) from the source artifact that supports the cited claim.",
  ),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ScopeNoteEnum = z.enum([
  // The model is confident, all data was in scope, no caveats.
  "in_scope",
  // Question is partially out of scope (e.g. asks about a peer not loaded).
  "partial_out_of_scope",
  // Question requires data we don't have (e.g. realized vs realizable pay).
  "needs_data_we_don_t_have",
  // Question needs subjective judgment beyond the deterministic facts.
  "interpretive",
  // Hard refusal — question asks for canonical data invention.
  "refused",
]);

export const AnswerSchema = z.object({
  title: z.string().min(2).max(120),
  summary: z.string().min(2).max(600),
  bullets: z
    .array(z.string().min(1).max(280))
    .min(0)
    .max(8)
    .describe("Optional supporting bullets, each tied to ≥1 citation."),
  citations: z
    .array(CitationSchema)
    .min(0)
    .max(20)
    .describe(
      "Every numeric or factual claim must cite the artifact it came from. " +
        "Empty array allowed only when scope_note='refused'.",
    ),
  scope_note: ScopeNoteEnum,
  scope_explanation: z.string().max(400).optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/**
 * Common refusal payload — used when the model fails the schema or
 * asks about something out of scope.
 */
export const REFUSAL: Answer = {
  title: "I can only answer about the loaded company and filing",
  summary:
    "ProxyMiner's assistant stays inside the company and filing currently open, with citations to public SEC proxy disclosures. Try rephrasing the question against this filing, or open a different company first.",
  bullets: [],
  citations: [],
  scope_note: "refused",
};
