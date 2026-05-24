/**
 * Phase 29 — pin the AskBox citation/scope-note display helpers.
 *
 * AskBox renders user-facing strings via these two pure mappers. The
 * tests below pin every known citation kind + scope-note value AND
 * the fallback behavior for unknown values, so the route can add new
 * kinds/notes without crashing the UI before the component knows
 * about them.
 */
import { describe, expect, it } from "vitest";

import { citationLabel, scopeNoteCopy } from "./answer-display";

describe("citationLabel (Phase 29)", () => {
  it("executive_comp combines exec, year, and field", () => {
    expect(
      citationLabel({
        kind: "executive_comp",
        ref: { executive_name: "Tim Cook", year: 2024, field: "total" },
      }),
    ).toBe("Tim Cook · 2024 · total");
  });

  it("executive_comp replaces underscores in field names with spaces", () => {
    expect(
      citationLabel({
        kind: "executive_comp",
        ref: {
          executive_name: "Tim Cook",
          year: 2024,
          field: "non_equity_incentive_plan_compensation",
        },
      }),
    ).toBe(
      "Tim Cook · 2024 · non equity incentive plan compensation",
    );
  });

  it("policy_fact prefixes with 'Policy:'", () => {
    expect(
      citationLabel({
        kind: "policy_fact",
        ref: { policy_type: "stock_ownership_guidelines" },
      }),
    ).toBe("Policy: stock ownership guidelines");
  });

  it("metric_fact prefixes with 'Metric:'", () => {
    expect(
      citationLabel({
        kind: "metric_fact",
        ref: { metric_name_normalized: "ceo_pay_ratio" },
      }),
    ).toBe("Metric: ceo pay ratio");
  });

  it("peer_group includes the group name when present", () => {
    expect(
      citationLabel({
        kind: "peer_group",
        ref: { peer_group_name: "2024 Peer Group" },
      }),
    ).toBe("Peer group · 2024 Peer Group");
  });

  it("peer_group omits the name suffix when absent", () => {
    expect(citationLabel({ kind: "peer_group", ref: {} })).toBe("Peer group");
  });

  it("peer_member uses company_name_raw", () => {
    expect(
      citationLabel({
        kind: "peer_member",
        ref: { company_name_raw: "Adobe Inc." },
      }),
    ).toBe("Peer member: Adobe Inc.");
  });

  it("section_excerpt appends 'excerpt'", () => {
    expect(
      citationLabel({
        kind: "section_excerpt",
        ref: { section_type: "compensation_committee_report" },
      }),
    ).toBe("compensation committee report excerpt");
  });

  it("filing_metadata names the field", () => {
    expect(
      citationLabel({
        kind: "filing_metadata",
        ref: { field: "filing_date" },
      }),
    ).toBe("Filing · filing date");
  });

  it("falls back to the raw kind string for unknown kinds", () => {
    // If the route adds a new citation kind before AskBox knows about
    // it, the citation chip must still render — better a less-pretty
    // label than blanking the chip.
    expect(citationLabel({ kind: "future_kind", ref: {} })).toBe("future_kind");
  });
});

describe("scopeNoteCopy (Phase 29)", () => {
  it("in_scope → ok", () => {
    expect(scopeNoteCopy("in_scope")).toEqual({
      tone: "ok",
      label: "In scope",
    });
  });

  it("partial_out_of_scope → warn", () => {
    expect(scopeNoteCopy("partial_out_of_scope")).toEqual({
      tone: "warn",
      label: "Partially out of scope",
    });
  });

  it("needs_data_we_don_t_have → warn", () => {
    expect(scopeNoteCopy("needs_data_we_don_t_have")).toEqual({
      tone: "warn",
      label: "Needs data not in this filing",
    });
  });

  it("interpretive → warn", () => {
    expect(scopeNoteCopy("interpretive")).toEqual({
      tone: "warn",
      label: "Interpretive",
    });
  });

  it("refused → stop", () => {
    expect(scopeNoteCopy("refused")).toEqual({
      tone: "stop",
      label: "Out of scope",
    });
  });

  it("falls back to ok + raw note for unknown values", () => {
    // Same forward-compat principle as citationLabel: unknown scope
    // notes don't crash the AskBox banner.
    expect(scopeNoteCopy("new_enum_value")).toEqual({
      tone: "ok",
      label: "new_enum_value",
    });
  });

  it("returns empty-string label for an empty input (no special-case)", () => {
    expect(scopeNoteCopy("")).toEqual({ tone: "ok", label: "" });
  });
});
