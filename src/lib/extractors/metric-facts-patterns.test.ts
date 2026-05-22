/**
 * Synthetic-CD&A unit tests for the metric-fact extractor (revenue,
 * TSR, relative TSR, operating_income, annual_incentive_payout,
 * performance_rsu_vesting, say_on_pay, ceo_pay_ratio).
 *
 * Phase 17 added policy-facts-patterns.test.ts (hedging/pledging/
 * clawback). Phase 18 mirrors that approach for metrics: every metric
 * extractor had ZERO direct synthetic coverage before this — they were
 * only exercised transitively through fixture parity tests, which skip
 * on CI when source.html isn't on disk.
 *
 * Each case below pins a canonical proxy phrasing observed in real
 * filings to the {metric_name_normalized, observed_value} pair the
 * SPECIAL_METRIC_PATTERNS regex set in facts.ts must produce. A
 * regression on any metric regex now fails the suite loudly with a
 * focused synthetic instead of a fixture parity diff.
 */
import { describe, expect, it } from "vitest";

import { extractFactsFromCda } from "./facts";

function metricsOf(text: string) {
  return extractFactsFromCda("test-metric", text).metrics.map((m) => ({
    name: m.metric_name_normalized,
    value: m.observed_value,
  }));
}

function findMetric(text: string, normalized: string) {
  return metricsOf(text).find((m) => m.name === normalized);
}

describe("metric-facts pattern extraction", () => {
  describe("revenue", () => {
    it("captures '$416.2 billion in revenue' table-row form", () => {
      // Mirrors the MSFT-style "fiscal year YYYY business performance
      // highlights ... revenue operating income ..." anchor block.
      const text =
        "Fiscal year 2024 business performance highlights percentages are year-over-year revenue operating income net income diluted earnings per share $416.2 billion $109.4 billion $88.1 billion $11.86 ";
      const m = findMetric(text, "revenue");
      expect(m?.value).toBe("$416.2 billion");
    });

    it("captures 'total revenue of $X billion' narrative form", () => {
      const text =
        "In fiscal 2024 we delivered strong financial performance, with total revenue of $98.0 billion, up 12% year-over-year.";
      const m = findMetric(text, "revenue");
      expect(m?.value).toBe("$98.0 billion");
    });

    it("captures 'reported revenue of $X' form", () => {
      const text =
        "We reported revenue of $34.9 billion for the year, reflecting strong business execution across all segments.";
      const m = findMetric(text, "revenue");
      expect(m?.value).toBe("$34.9 billion");
    });
  });

  describe("operating_income", () => {
    it("captures 'operating income results of $X billion'", () => {
      const text =
        "Our strong financial performance was driven by operating income results of $57.4 billion, a 12% increase over the prior year.";
      const m = findMetric(text, "operating_income");
      expect(m?.value).toBe("$57.4 billion");
    });

    it("captures 'reported operating income of $X' form", () => {
      const text =
        "We reported operating income of $22.6 billion in fiscal 2024, demonstrating the operating leverage of our model.";
      const m = findMetric(text, "operating_income");
      expect(m?.value).toBe("$22.6 billion");
    });
  });

  describe("relative_tsr", () => {
    it("captures 'Our TSR was at the 81.20th percentile'", () => {
      const text =
        "Based on this result, our TSR relative to the S&P 500 was at the 81.20th percentile, which produced a positive relative total shareholder return modifier payout.";
      const m = findMetric(text, "relative_tsr");
      expect(m?.value).toBe("81.20th percentile");
    });

    it("captures 'achieving a relative total shareholder return at the Nth percentile'", () => {
      const text =
        "Our financial performance translated into award funding consistent with achieving a relative total shareholder return at the 65th percentile of our peer group index.";
      const m = findMetric(text, "relative_tsr");
      expect(m?.value).toBe("65th percentile");
    });
  });

  describe("annual_incentive_payout", () => {
    it("captures 'NN% payout under our annual cash incentive plan'", () => {
      const text =
        "The Committee approved bonus payouts equal to 132% of the total target bonus opportunity, resulting in a 132% payout under our 2024 cash incentive plan.";
      const m = findMetric(text, "annual_incentive_payout");
      expect(m?.value).toContain("132%");
    });

    it("captures 'company performance percentage of NN%'", () => {
      const text =
        "After evaluating annual performance against our pre-established metrics, the Committee approved a company performance percentage of 105% for the annual cash incentive plan.";
      const m = findMetric(text, "annual_incentive_payout");
      expect(m?.value).toContain("105%");
    });
  });

  describe("performance_rsu_vesting", () => {
    it("captures 'vested in NN% of the target performance-based RSUs'", () => {
      const text =
        "As a result of relative performance against our peer group, the NEOs vested in 156% of the target performance-based RSUs granted in fiscal 2022.";
      const m = findMetric(text, "performance_rsu_vesting");
      expect(m?.value).toContain("156%");
    });
  });

  describe("say_on_pay", () => {
    it("captures '92.2% of votes cast in favor' canonical phrasing", () => {
      const text =
        "At our 2024 annual meeting, our say-on-pay proposal received the support of 92.2% of the votes cast in favor of the advisory resolution on NEO compensation.";
      const m = findMetric(text, "say_on_pay");
      expect(m?.value).toContain("92.2");
    });

    it("captures 'say-on-pay proposal received NN% support' shorthand", () => {
      const text =
        "Our say-on-pay proposal received approximately 95% support at our 2023 annual meeting of stockholders, reflecting continued shareholder confidence in our pay program.";
      const m = findMetric(text, "say_on_pay");
      expect(m?.value).toContain("95");
    });
  });

  describe("ceo_pay_ratio", () => {
    it("captures canonical 'ratio of ... CEO ... to ... median ... was N to 1'", () => {
      const text =
        "The ratio of the annual total compensation of our CEO to the annual total compensation of our median employee was 312 to 1 for fiscal 2024.";
      const m = findMetric(text, "ceo_pay_ratio");
      expect(m?.value).toBe("312 to 1");
    });
  });
});
