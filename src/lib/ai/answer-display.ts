/**
 * Pure presentation helpers for the AskBox UI.
 *
 * The Ask route returns answers in a fixed schema; AskBox renders
 * them with two small mappers (citation label + scope-note tone).
 * Extracting them here lets vitest pin the contract without
 * spinning up React/jsdom — and lets the route's audit-log /
 * citation-validation code reuse the same labels if it ever needs
 * to surface them in a server response.
 */

export type CitationKind =
  | "executive_comp"
  | "policy_fact"
  | "metric_fact"
  | "peer_group"
  | "peer_member"
  | "section_excerpt"
  | "filing_metadata";

export interface CitationLike {
  kind: string;
  ref: Record<string, unknown>;
}

/**
 * Render a single Ask citation as a short human-readable label, e.g.
 * "Tim Cook · 2024 · total".
 *
 * Tolerates a `kind` we don't recognise — returns the raw kind string
 * so the UI never blanks the citation just because the route added a
 * new kind. Also tolerates a `ref` missing a field; the field name
 * comes back as `undefined`/`null` rendered as the literal string, but
 * the rest of the citation still surfaces.
 */
export function citationLabel(c: CitationLike): string {
  const ref = c.ref as Record<string, string | number | undefined>;
  switch (c.kind) {
    case "executive_comp":
      return `${ref.executive_name} · ${ref.year} · ${String(ref.field).replace(/_/g, " ")}`;
    case "policy_fact":
      return `Policy: ${String(ref.policy_type).replace(/_/g, " ")}`;
    case "metric_fact":
      return `Metric: ${String(ref.metric_name_normalized).replace(/_/g, " ")}`;
    case "peer_group":
      return `Peer group${ref.peer_group_name ? ` · ${ref.peer_group_name}` : ""}`;
    case "peer_member":
      return `Peer member: ${ref.company_name_raw}`;
    case "section_excerpt":
      return `${String(ref.section_type).replace(/_/g, " ")} excerpt`;
    case "filing_metadata":
      return `Filing · ${String(ref.field).replace(/_/g, " ")}`;
    default:
      return c.kind;
  }
}

export type ScopeNoteTone = "ok" | "warn" | "stop";

export interface ScopeNoteCopy {
  tone: ScopeNoteTone;
  label: string;
}

/**
 * Map the route's `scope_note` enum to a tone + human label used in
 * the AskBox banner. Unknown values pass through with `tone: "ok"`
 * and the raw note as the label, so a future enum value can ship in
 * the route before the UI knows about it without crashing.
 */
export function scopeNoteCopy(note: string): ScopeNoteCopy {
  switch (note) {
    case "in_scope":
      return { tone: "ok", label: "In scope" };
    case "partial_out_of_scope":
      return { tone: "warn", label: "Partially out of scope" };
    case "needs_data_we_don_t_have":
      return { tone: "warn", label: "Needs data not in this filing" };
    case "interpretive":
      return { tone: "warn", label: "Interpretive" };
    case "refused":
      return { tone: "stop", label: "Out of scope" };
    default:
      return { tone: "ok", label: note };
  }
}
