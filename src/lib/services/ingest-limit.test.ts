import { describe, expect, it } from "vitest";

import {
  INGEST_LIMIT_DEFAULT,
  INGEST_LIMIT_MAX,
  INGEST_LIMIT_MIN,
  parseIngestLimit,
} from "./ingest-limit";

describe("parseIngestLimit", () => {
  it("defaults to 2 when the param is absent or empty", () => {
    for (const raw of [null, undefined, ""]) {
      expect(parseIngestLimit(raw)).toEqual({
        ok: true,
        limit: INGEST_LIMIT_DEFAULT,
      });
    }
  });

  it("accepts every in-range value 1-5", () => {
    for (let n = INGEST_LIMIT_MIN; n <= INGEST_LIMIT_MAX; n++) {
      expect(parseIngestLimit(String(n))).toEqual({ ok: true, limit: n });
    }
  });

  it("rejects out-of-range integers (0 and 6)", () => {
    expect(parseIngestLimit("0").ok).toBe(false);
    expect(parseIngestLimit("6").ok).toBe(false);
  });

  it("rejects overflow / over-long digit strings", () => {
    expect(parseIngestLimit("100").ok).toBe(false);
    expect(parseIngestLimit("9999999999999999999999").ok).toBe(false);
  });

  it("rejects non-numeric, negative, decimal and whitespace forms", () => {
    for (const raw of ["abc", "-1", "2.5", " 3 ", "3a", "0x3", "+3", "e1"]) {
      expect(parseIngestLimit(raw).ok).toBe(false);
    }
  });

  it("never returns a limit outside [MIN, MAX] on the ok path", () => {
    for (const raw of ["1", "2", "3", "4", "5", "", "9", "abc"]) {
      const r = parseIngestLimit(raw);
      if (r.ok) {
        expect(r.limit).toBeGreaterThanOrEqual(INGEST_LIMIT_MIN);
        expect(r.limit).toBeLessThanOrEqual(INGEST_LIMIT_MAX);
      }
    }
  });

  it("provides a string error message when rejecting", () => {
    const r = parseIngestLimit("99");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe("string");
  });
});
