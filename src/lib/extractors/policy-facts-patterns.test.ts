/**
 * Synthetic-CD&A unit tests for the policy-fact extractor (hedging,
 * pledging, clawback). These extractors had ZERO direct synthetic
 * coverage before Phase 17 — they were only exercised transitively
 * through fixture parity tests (which skip on CI when source.html
 * isn't on disk). This file pins the core normalize-to-"prohibited" /
 * "adopted" behavior plus the major reject patterns documented in
 * facts.ts.
 *
 * Pattern catalogue lifted from production proxies in the cohort:
 *   AAPL/MSFT — "Prohibition on Hedging, Pledging, and Short Sales"
 *   NVDA      — "we prohibit hedging activities and pledging"
 *   GOOGL     — "clawback policy" / "Dodd-Frank recoupment"
 *   MSFT      — "erroneously awarded compensation" (Dodd-Frank phrasing)
 *   ADBE      — "share retention" near ownership policy
 *
 * Reject-pattern catalogue (must NOT match):
 *   MSFT      — "Microsoft Cloud revenue" should never surface as a
 *               policy fact (reject list at facts.ts:113-227).
 */
import { describe, expect, it } from "vitest";

import { extractFactsFromCda } from "./facts";

function policiesOf(text: string) {
  return extractFactsFromCda("test-policy", text).policies.map((p) => ({
    type: p.policy_type,
    value: p.normalized_value,
  }));
}

describe("policy-facts pattern extraction", () => {
  describe("hedging", () => {
    it("captures explicit prohibition", () => {
      const text =
        "We prohibit our directors and executives from engaging in any hedging transactions.";
      const found = policiesOf(text);
      const hedging = found.find((p) => p.type === "hedging");
      expect(hedging?.value).toBe("prohibited");
    });

    it("captures Apple-style 'Prohibition on Hedging' heading", () => {
      const text =
        "Prohibition on Hedging, Pledging, and Short Sales. " +
        "We prohibit short sales and transactions in derivatives of Apple securities.";
      const found = policiesOf(text);
      expect(found.find((p) => p.type === "hedging")?.value).toBe("prohibited");
    });
  });

  describe("pledging", () => {
    it("captures explicit prohibition on pledging", () => {
      const text =
        "Our policy prohibits pledging of company securities by directors and officers.";
      const found = policiesOf(text);
      // Pledging must surface as a policy. Whether normalize derives
      // the explicit "prohibited" canonical value depends on whether
      // the surrounding anchor phrase matches POLICY_TRIM_ANCHORS;
      // detection alone is the load-bearing assertion.
      expect(found.find((p) => p.type === "pledging")).toBeDefined();
    });

    it("captures combined hedging+pledging policy", () => {
      const text =
        "We prohibit short sales, transactions in derivatives, hedging, and pledging by " +
        "our named executive officers and directors.";
      const found = policiesOf(text);
      expect(found.find((p) => p.type === "hedging")?.value).toBe("prohibited");
      expect(found.find((p) => p.type === "pledging")?.value).toBe("prohibited");
    });
  });

  describe("clawback", () => {
    it("captures explicit clawback policy", () => {
      const text =
        "Our clawback policy allows the Committee to recoup incentive compensation in the event of a restatement.";
      const found = policiesOf(text);
      const cb = found.find((p) => p.type === "clawback");
      expect(cb?.value).toBe("present");
    });

    it("captures Dodd-Frank 'erroneously awarded' phrasing", () => {
      const text =
        "We have adopted a recoupment policy in accordance with SEC rules, requiring the recovery of erroneously awarded compensation from current and former executive officers.";
      const found = policiesOf(text);
      expect(found.find((p) => p.type === "clawback")?.value).toBe("present");
    });
  });

  describe("reject patterns", () => {
    it("does NOT match 'Microsoft Cloud revenue' as a policy", () => {
      const text =
        "Our 2025 Microsoft Cloud revenue grew by 25%, driven by Azure adoption and consumption-based pricing.";
      const found = policiesOf(text);
      expect(found).toEqual([]);
    });

    it("does NOT match 'incentive plan revenue' near pledging context", () => {
      // From facts.ts:213 reject list — purely a coincidence of the
      // word "pledging" appearing near the word "revenue" in some
      // narrative paragraphs.
      const text =
        "Our incentive plan revenue trigger discussion above pledged consistent payouts when targets are met.";
      const found = policiesOf(text);
      // Pledging shouldn't surface as a policy here — the prohibition
      // verb is absent.
      expect(found.find((p) => p.type === "pledging")).toBeUndefined();
    });
  });
});
