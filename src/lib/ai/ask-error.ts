/**
 * Phase 32 — categorize provider errors from the BYOK Gemini call
 * into typed buckets + fixed user-facing copy.
 *
 * Extracted from /api/ask/route.ts so each category branch is unit-
 * testable AND the security guarantee is explicit:
 *
 *   The user-facing `scope_explanation` string returned here is
 *   ALWAYS one of the fixed strings below. The raw provider message
 *   is never spliced into the response. If a future Gemini error
 *   payload contains the user's API key (some providers historically
 *   echo it back in 401 bodies), the categorizer's substring match
 *   reads it but the returned copy never includes it.
 *
 * Pure; no I/O.
 */

export type AskErrorCategory =
  | "invalid_key"
  | "quota"
  | "rate"
  | "timeout"
  | "unavailable"
  | "unknown";

export interface AskErrorClassification {
  scope_explanation: string;
  category: AskErrorCategory;
}

const COPY: Record<AskErrorCategory, string> = {
  invalid_key:
    "Your Google AI Studio key didn't work — replace it and try again.",
  quota:
    "Your Google free-tier quota is exhausted for the day. Resets at midnight Pacific.",
  rate:
    "You're sending requests faster than Google's free tier allows. Wait a minute and try again.",
  timeout: "Request timed out. Try a more focused question or retry.",
  unavailable: "Google's API is temporarily unavailable. Retry shortly.",
  unknown: "The model couldn't return a structured answer. Try rephrasing.",
};

/**
 * Map a provider error to a typed category + user-facing copy.
 *
 * The match order matters: more specific signals (the literal phrase
 * "api_key", explicit "quota" / "rate") run before the generic
 * `unavailable` bucket so a "503 quota exceeded" message classifies
 * as `quota`, not `unavailable`.
 *
 * Accepts any unknown; non-Error inputs are coerced via `String(...)`.
 */
export function categorizeAskProviderError(err: unknown): AskErrorClassification {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (msg.includes("invalid") && (msg.includes("api key") || msg.includes("token"))) {
    return { category: "invalid_key", scope_explanation: COPY.invalid_key };
  }
  if (
    msg.includes("permission") ||
    msg.includes("not authorized") ||
    msg.includes("api_key")
  ) {
    // Distinct copy: the key is recognised but not allowed for this
    // model. Same category for caller-side handling (BYOK retry).
    return {
      category: "invalid_key",
      scope_explanation:
        "The provided key doesn't have access to this model.",
    };
  }
  if (msg.includes("quota") || msg.includes("daily limit")) {
    return { category: "quota", scope_explanation: COPY.quota };
  }
  if (msg.includes("rate") || msg.includes("429") || msg.includes("too many")) {
    return { category: "rate", scope_explanation: COPY.rate };
  }
  if (msg.includes("timeout") || msg.includes("deadline")) {
    return { category: "timeout", scope_explanation: COPY.timeout };
  }
  if (msg.includes("unavailable") || msg.includes("503") || msg.includes("502")) {
    return { category: "unavailable", scope_explanation: COPY.unavailable };
  }
  return { category: "unknown", scope_explanation: COPY.unknown };
}
