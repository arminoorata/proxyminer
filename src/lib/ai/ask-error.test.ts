/**
 * Phase 32 — pin every classification branch of the Ask provider
 * error categorizer, AND pin the security guarantee that no provider
 * message ever leaks into the user-facing response.
 */
import { describe, expect, it } from "vitest";

import { categorizeAskProviderError } from "./ask-error";

describe("categorizeAskProviderError (Phase 32)", () => {
  it("Invalid+api key → invalid_key", () => {
    const r = categorizeAskProviderError(new Error("Invalid API key supplied"));
    expect(r.category).toBe("invalid_key");
    expect(r.scope_explanation).toMatch(/replace it/);
  });

  it("Invalid+token → invalid_key", () => {
    expect(
      categorizeAskProviderError(new Error("Invalid token: malformed")).category,
    ).toBe("invalid_key");
  });

  it("permission denied → invalid_key with distinct copy", () => {
    const r = categorizeAskProviderError(new Error("Permission denied"));
    expect(r.category).toBe("invalid_key");
    expect(r.scope_explanation).toMatch(/doesn't have access/);
  });

  it("'not authorized' → invalid_key", () => {
    expect(
      categorizeAskProviderError(new Error("not authorized for this model"))
        .category,
    ).toBe("invalid_key");
  });

  it("bare api_key mention → invalid_key (covers SDK error shape that names the field)", () => {
    expect(
      categorizeAskProviderError(new Error("Required field api_key was not set"))
        .category,
    ).toBe("invalid_key");
  });

  it("quota → quota", () => {
    expect(
      categorizeAskProviderError(new Error("Quota exceeded for this project"))
        .category,
    ).toBe("quota");
  });

  it("daily limit → quota", () => {
    expect(
      categorizeAskProviderError(new Error("daily limit reached")).category,
    ).toBe("quota");
  });

  it("rate / 429 / too many → rate", () => {
    for (const msg of ["Rate limit exceeded", "HTTP 429", "Too many requests"]) {
      expect(
        categorizeAskProviderError(new Error(msg)).category,
        `msg=${msg}`,
      ).toBe("rate");
    }
  });

  it("timeout / deadline → timeout", () => {
    expect(categorizeAskProviderError(new Error("Request timeout")).category).toBe(
      "timeout",
    );
    expect(
      categorizeAskProviderError(new Error("deadline exceeded")).category,
    ).toBe("timeout");
  });

  it("unavailable / 502 / 503 → unavailable", () => {
    for (const msg of ["Service unavailable", "502 Bad Gateway", "HTTP 503"]) {
      expect(
        categorizeAskProviderError(new Error(msg)).category,
        `msg=${msg}`,
      ).toBe("unavailable");
    }
  });

  it("unknown → unknown with generic copy", () => {
    const r = categorizeAskProviderError(new Error("something went wrong"));
    expect(r.category).toBe("unknown");
    expect(r.scope_explanation).toMatch(/Try rephrasing/);
  });

  it("non-Error inputs coerce safely (no throw)", () => {
    expect(categorizeAskProviderError("string error").category).toBe("unknown");
    expect(categorizeAskProviderError(null).category).toBe("unknown");
    expect(categorizeAskProviderError(undefined).category).toBe("unknown");
    expect(categorizeAskProviderError(42).category).toBe("unknown");
    expect(categorizeAskProviderError({ ohno: true }).category).toBe("unknown");
  });

  it("more specific signals win over generic 'unavailable' (precedence pin)", () => {
    // A "503 quota exceeded" message must classify as quota — caller
    // hands the user a quota-specific retry suggestion, not the
    // generic "retry shortly" copy.
    const r = categorizeAskProviderError(new Error("503 quota exceeded"));
    expect(r.category).toBe("quota");
  });

  // ── Security pin ───────────────────────────────────────────────────
  // The categorizer reads the raw provider message but returns ONLY
  // the fixed COPY strings. If a future Gemini error payload echoes
  // the user's API key back (which some providers historically do
  // in 401 bodies), the key must NOT surface in `scope_explanation`.

  it("does not echo the input message into scope_explanation (security)", () => {
    const sensitive = "Invalid API key: AIza-FAKE-KEY-SHOULD-NOT-LEAK-1234567890";
    const r = categorizeAskProviderError(new Error(sensitive));
    expect(r.category).toBe("invalid_key");
    // The categorizer's copy must not contain ANY substring from the
    // raw error — pinning that the user-facing string is a known
    // fixed value, not a synthesised message.
    expect(r.scope_explanation).not.toContain("AIza");
    expect(r.scope_explanation).not.toContain("FAKE");
    expect(r.scope_explanation).not.toContain("1234567890");
  });

  it("does not echo a 'quota' message containing identifying detail (security)", () => {
    const r = categorizeAskProviderError(
      new Error("quota exceeded for project user@example.com"),
    );
    expect(r.category).toBe("quota");
    expect(r.scope_explanation).not.toContain("user@example.com");
  });

  it("does not echo a 'rate' message containing identifying detail (security)", () => {
    const r = categorizeAskProviderError(
      new Error("rate limit on key AIza-leaky-token"),
    );
    expect(r.category).toBe("rate");
    expect(r.scope_explanation).not.toContain("AIza");
  });
});
