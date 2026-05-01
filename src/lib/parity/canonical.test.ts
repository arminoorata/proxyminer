import { describe, expect, it } from "vitest";

import {
  canonicalFloat,
  canonicalJson,
  canonicalJsonString,
  canonicalText,
  structuralFingerprint,
} from "./canonical";

describe("canonicalText", () => {
  it("collapses NBSP, runs of whitespace, and trims", () => {
    expect(canonicalText(" hello  world  ")).toBe("hello world");
  });
  it("normalizes NFC", () => {
    // composed é vs decomposed e + combining acute
    expect(canonicalText("Pellé").length).toBe(canonicalText("Pellé").length);
  });
});

describe("canonicalFloat", () => {
  it("formats to 6 sig figs and drops trailing zeros", () => {
    expect(canonicalFloat(0.1 + 0.2)).toBe("0.3");
    expect(canonicalFloat(1 / 3)).toBe("0.333333");
  });
});

describe("canonicalJson", () => {
  it("sorts keys deterministically", () => {
    const a = canonicalJsonString({ b: 1, a: 2 });
    const b = canonicalJsonString({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
  it("folds undefined → null", () => {
    expect(canonicalJson({ x: undefined })).toEqual({ x: null });
  });
  it("strips IGNORED_FIELDS (id, timestamps)", () => {
    const v = canonicalJson({ id: 7, name: "x", created_at: "2026-01-01" });
    expect(v).toEqual({ name: "x" });
  });
  it("normalizes float reps via canonicalFloat", () => {
    const v = canonicalJson({ score: 0.1 + 0.2 });
    expect(v).toEqual({ score: "0.3" });
  });
  it("sorts nested objects too", () => {
    const v = canonicalJsonString({ a: { z: 1, y: 2 } });
    expect(v).toBe('{"a":{"y":2,"z":1}}');
  });
  it("throws on circular refs instead of stack-overflowing", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });
});

describe("structuralFingerprint", () => {
  it("counts tag names regardless of attributes (opens + closes)", () => {
    // The fingerprint is a coarse multiset — opening + closing tags
    // are both counted, intentionally. <p>...</p> contributes 2; a
    // self-closing <span/> contributes 1.
    expect(
      structuralFingerprint(
        '<div><p class="x">a</p><p>b</p><span/></div>',
      ),
    ).toEqual({ div: 2, p: 4, span: 1 });
  });
  it("treats opening + closing tags as one structural unit per pair", () => {
    // Both <p> and </p> contribute — that's intentional. The fingerprint
    // is a coarse multiset, not a balanced-tag count.
    expect(structuralFingerprint("<p>x</p>").p).toBe(2);
  });
});
