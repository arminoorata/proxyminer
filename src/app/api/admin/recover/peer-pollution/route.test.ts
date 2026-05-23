/**
 * Phase 23: recover-peer-pollution input validation + structured
 * error shaping. These run offline — no Drizzle, no Postgres. The
 * route's DB-call branches are exercised end-to-end by the workflow
 * driver against production; what we pin here is the bits whose
 * shape must NOT silently drift, since the workflow driver parses
 * them.
 */
import { describe, expect, it } from "vitest";

import {
  _describeDbErrorForTests as describeDbError,
  _normalizeStringListForTests as normalizeStringList,
} from "./route";

describe("normalizeStringList (Phase 23)", () => {
  it("trims, deduplicates, and preserves order on first occurrence", () => {
    expect(normalizeStringList([" crm ", "nflx", "crm"], "parents", 10)).toEqual(
      ["crm", "nflx"],
    );
  });

  it("rejects non-array input", () => {
    expect(() => normalizeStringList("crm", "parents", 10)).toThrow(
      /must be an array/,
    );
  });

  it("rejects empty entries", () => {
    expect(() => normalizeStringList(["crm", "   "], "parents", 10)).toThrow(
      /non-empty strings/,
    );
  });

  it("rejects entries longer than 32 chars", () => {
    expect(() =>
      normalizeStringList(["a".repeat(33)], "parents", 10),
    ).toThrow(/too long/);
  });

  it("rejects entries with invalid characters (e.g. SQL meta-chars)", () => {
    expect(() => normalizeStringList(["crm;DROP"], "parents", 10)).toThrow(
      /invalid characters/,
    );
    expect(() => normalizeStringList(["crm'"], "parents", 10)).toThrow(
      /invalid characters/,
    );
  });

  it("rejects empty list", () => {
    expect(() => normalizeStringList([], "parents", 10)).toThrow(
      /at least one/,
    );
  });

  it("rejects oversize list", () => {
    expect(() => normalizeStringList(["a", "b", "c"], "parents", 2)).toThrow(
      /too large/,
    );
  });

  it("accepts dotted/hyphenated tickers (BRK.B, BRK-A)", () => {
    expect(normalizeStringList(["BRK.B", "BRK-A"], "suspects", 10)).toEqual([
      "BRK.B",
      "BRK-A",
    ]);
  });
});

describe("describeDbError (Phase 23)", () => {
  it("extracts pg-style code + message from a postgres error object", () => {
    expect(
      describeDbError({ code: "42P01", message: 'relation "x" does not exist' }),
    ).toEqual({
      code: "42P01",
      message: 'relation "x" does not exist',
    });
  });

  it("falls back to detail when message is missing", () => {
    expect(describeDbError({ code: "23505", detail: "Key already exists." })).toEqual(
      { code: "23505", message: "Key already exists." },
    );
  });

  it("handles plain Error instances", () => {
    expect(describeDbError(new Error("boom"))).toEqual({
      code: null,
      message: "boom",
    });
  });

  it("handles non-object values", () => {
    expect(describeDbError("string error")).toEqual({
      code: null,
      message: "string error",
    });
    expect(describeDbError(null)).toEqual({ code: null, message: "unknown error" });
  });

  it("returns sentinel for object errors without message or detail", () => {
    expect(describeDbError({ code: "08006" })).toEqual({
      code: "08006",
      message: "unknown database error",
    });
  });
});
