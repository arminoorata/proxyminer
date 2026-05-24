/**
 * Phase 30 — defensive shape validator for the /api/ask response.
 *
 * The Ask route's documented response shape is
 *   { title, summary, bullets[], citations[], scope_note, scope_explanation? }
 * but JSON from any LLM-mediated path is the canonical "trust no
 * shape" surface. AskBox runs this guard before rendering anything;
 * extracting it here makes every reject path unit-testable without
 * spinning up React, AND lets the route reuse the exact same
 * predicate if it ever needs to validate a third-party POST.
 *
 * Pure; no I/O.
 */

export interface AnswerCitation {
  kind: string;
  filing_id: string;
  excerpt: string;
  ref: Record<string, unknown>;
}

export interface Answer {
  title: string;
  summary: string;
  bullets: string[];
  citations: AnswerCitation[];
  scope_note: string;
  scope_explanation?: string | null;
}

function isCitation(c: unknown): c is AnswerCitation {
  if (!c || typeof c !== "object") return false;
  const cc = c as Record<string, unknown>;
  return (
    typeof cc.kind === "string" &&
    typeof cc.filing_id === "string" &&
    typeof cc.excerpt === "string" &&
    cc.ref !== null &&
    typeof cc.ref === "object"
  );
}

export function isAnswer(v: unknown): v is Answer {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.title === "string" &&
    typeof a.summary === "string" &&
    Array.isArray(a.bullets) &&
    a.bullets.every((b) => typeof b === "string") &&
    Array.isArray(a.citations) &&
    a.citations.every(isCitation) &&
    typeof a.scope_note === "string"
  );
}
