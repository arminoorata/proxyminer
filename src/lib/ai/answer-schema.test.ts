/**
 * Phase 30 — pin every reject path of the Ask-response shape guard.
 *
 * AskBox runs this validator before rendering anything from the
 * /api/ask response. The contract:
 *   - canonical shape passes
 *   - any wrong-typed top-level field rejects
 *   - bullets must all be strings
 *   - every citation must have kind/filing_id/excerpt/ref shape
 *   - non-object input rejects (null, undefined, primitives)
 *   - unknown extra fields don't reject (forward-compat)
 *
 * The route's contract is also frozen by these tests — if a route
 * change drops a required field, AskBox would stop rendering until
 * fixed; better to fail the test here than in production.
 */
import { describe, expect, it } from "vitest";

import { isAnswer, type Answer } from "./answer-schema";

function canonical(): Answer {
  return {
    title: "Apple Inc. CEO compensation",
    summary: "Tim Cook earned $74.6M in 2024.",
    bullets: ["Salary $3M", "Equity $58M"],
    citations: [
      {
        kind: "executive_comp",
        filing_id: "000130817925000008",
        excerpt: "Tim Cook · 2024 · total · $74,610,235",
        ref: { executive_name: "Tim Cook", year: 2024, field: "total" },
      },
    ],
    scope_note: "in_scope",
  };
}

describe("isAnswer (Phase 30)", () => {
  it("accepts the canonical Ask response shape", () => {
    expect(isAnswer(canonical())).toBe(true);
  });

  it("accepts an optional scope_explanation field", () => {
    expect(isAnswer({ ...canonical(), scope_explanation: "category: ok" })).toBe(
      true,
    );
    expect(isAnswer({ ...canonical(), scope_explanation: null })).toBe(true);
  });

  it("tolerates unknown extra top-level fields (forward-compat)", () => {
    expect(isAnswer({ ...canonical(), trace_id: "abc-123" })).toBe(true);
  });

  it("rejects null / undefined / primitives", () => {
    expect(isAnswer(null)).toBe(false);
    expect(isAnswer(undefined)).toBe(false);
    expect(isAnswer("answer")).toBe(false);
    expect(isAnswer(42)).toBe(false);
    expect(isAnswer(true)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(isAnswer({})).toBe(false);
  });

  it("rejects when title is missing or not a string", () => {
    expect(isAnswer({ ...canonical(), title: undefined })).toBe(false);
    expect(isAnswer({ ...canonical(), title: 42 })).toBe(false);
  });

  it("rejects when summary is missing", () => {
    const obj = canonical() as Partial<Answer>;
    delete obj.summary;
    expect(isAnswer(obj)).toBe(false);
  });

  it("rejects when bullets is not an array", () => {
    expect(isAnswer({ ...canonical(), bullets: "two" })).toBe(false);
    expect(isAnswer({ ...canonical(), bullets: { 0: "a" } })).toBe(false);
  });

  it("rejects when any bullet is not a string", () => {
    expect(isAnswer({ ...canonical(), bullets: ["ok", 42] })).toBe(false);
    expect(isAnswer({ ...canonical(), bullets: ["ok", null] })).toBe(false);
  });

  it("accepts empty bullets[] and empty citations[]", () => {
    // An answer can legitimately be summary-only with no bullets or
    // citations (e.g., a refusal). Don't reject that shape.
    expect(
      isAnswer({ ...canonical(), bullets: [], citations: [] }),
    ).toBe(true);
  });

  it("rejects when citations is not an array", () => {
    expect(isAnswer({ ...canonical(), citations: null })).toBe(false);
  });

  it("rejects when any citation is missing required fields", () => {
    const broken = {
      ...canonical(),
      citations: [{ kind: "executive_comp", filing_id: "x", excerpt: "y" }],
    };
    expect(isAnswer(broken)).toBe(false);
  });

  it("rejects when a citation's ref is null or not an object", () => {
    const refNull = {
      ...canonical(),
      citations: [{ ...canonical().citations[0], ref: null }],
    };
    expect(isAnswer(refNull)).toBe(false);

    const refString = {
      ...canonical(),
      citations: [
        { ...canonical().citations[0], ref: "tim cook" as unknown },
      ],
    };
    expect(isAnswer(refString)).toBe(false);
  });

  it("rejects when scope_note is not a string", () => {
    expect(isAnswer({ ...canonical(), scope_note: null })).toBe(false);
    expect(isAnswer({ ...canonical(), scope_note: 7 })).toBe(false);
  });
});
