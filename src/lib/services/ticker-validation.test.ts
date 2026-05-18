/**
 * Shape gate for public-ingest ticker inputs. The gate is the only
 * thing standing between user input and a SEC EDGAR roundtrip, so
 * the boundaries get tested carefully.
 */
import { describe, expect, it } from "vitest";

import {
  isValidTickerShape,
  normalizeTickerForDb,
  TICKER_PATTERN,
} from "./ticker-validation";

describe("isValidTickerShape", () => {
  it("accepts standard 1–5 letter tickers", () => {
    expect(isValidTickerShape("A")).toBe(true);
    expect(isValidTickerShape("AAPL")).toBe(true);
    expect(isValidTickerShape("GOOGL")).toBe(true);
  });

  it("accepts dual-class share suffixes (BRK.A / BRK.B)", () => {
    expect(isValidTickerShape("BRK.A")).toBe(true);
    expect(isValidTickerShape("BRK.B")).toBe(true);
    expect(isValidTickerShape("BF.B")).toBe(true);
  });

  it("accepts hyphenated tickers", () => {
    expect(isValidTickerShape("BF-A")).toBe(true);
  });

  it("trims whitespace before validating", () => {
    expect(isValidTickerShape("  AAPL  ")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isValidTickerShape("")).toBe(false);
    expect(isValidTickerShape("   ")).toBe(false);
    expect(isValidTickerShape(null)).toBe(false);
    expect(isValidTickerShape(undefined)).toBe(false);
  });

  it("rejects strings longer than 8 chars", () => {
    expect(isValidTickerShape("TOOLONGTICKER")).toBe(false);
    expect(isValidTickerShape("ABCDEFGHI")).toBe(false);
  });

  it("rejects strings starting with a digit", () => {
    expect(isValidTickerShape("1AAPL")).toBe(false);
    expect(isValidTickerShape("123")).toBe(false);
  });

  it("rejects strings with disallowed characters", () => {
    expect(isValidTickerShape("AAPL$")).toBe(false);
    expect(isValidTickerShape("AAPL!")).toBe(false);
    expect(isValidTickerShape("AAPL Inc")).toBe(false);
    expect(isValidTickerShape("AAPL/B")).toBe(false);
    // Quotes / SQLi-shaped junk
    expect(isValidTickerShape("AAPL';--")).toBe(false);
  });

  it("rejects full company names", () => {
    expect(isValidTickerShape("Apple Inc.")).toBe(false);
    expect(isValidTickerShape("Microsoft")).toBe(false);
  });

  it("TICKER_PATTERN is a strict anchor pattern", () => {
    // Sanity check the regex is anchored — without ^/$ a string like
    // "garbage AAPL garbage" would slip through.
    expect(TICKER_PATTERN.test("garbage AAPL garbage")).toBe(false);
  });
});

describe("normalizeTickerForDb", () => {
  it("lowercases and trims", () => {
    expect(normalizeTickerForDb("  AAPL  ")).toBe("aapl");
    expect(normalizeTickerForDb("BRK.A")).toBe("brk.a");
  });
});
