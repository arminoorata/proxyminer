/**
 * Pure helpers for the public-ingest rate gate. The DB-backed
 * `checkRateGate` is exercised end-to-end against production after
 * deploy; here we test the IP-extraction + hashing surface in
 * isolation since that's where a regression would silently break the
 * 5/hour cap (every request would collapse to one bucket).
 */
import { describe, expect, it } from "vitest";

import { extractClientIp, hashClient } from "./public-ingest-gate";

function headers(input: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(input)) h.set(k, v);
  return h;
}

describe("extractClientIp", () => {
  it("takes the first IP from x-forwarded-for", () => {
    expect(
      extractClientIp(headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })),
    ).toBe("203.0.113.5");
  });

  it("trims whitespace inside the XFF list", () => {
    expect(
      extractClientIp(headers({ "x-forwarded-for": "  203.0.113.5 , 10.0.0.1" })),
    ).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when XFF is absent", () => {
    expect(extractClientIp(headers({ "x-real-ip": "198.51.100.7" }))).toBe(
      "198.51.100.7",
    );
  });

  it("returns 'anon' when no forwarded headers are present", () => {
    expect(extractClientIp(headers({}))).toBe("anon");
  });

  it("prefers XFF over x-real-ip when both are present", () => {
    expect(
      extractClientIp(
        headers({
          "x-forwarded-for": "203.0.113.5",
          "x-real-ip": "198.51.100.7",
        }),
      ),
    ).toBe("203.0.113.5");
  });
});

describe("hashClient", () => {
  it("is deterministic for the same input", () => {
    expect(hashClient("203.0.113.5")).toBe(hashClient("203.0.113.5"));
  });

  it("produces different hashes for different IPs", () => {
    expect(hashClient("203.0.113.5")).not.toBe(hashClient("203.0.113.6"));
  });

  it("collapses null / undefined / empty to a single 'anon' bucket", () => {
    // The cap is meant to apply to the unknown-client bucket too, but
    // we accept that all unknown clients share one bucket — that's a
    // privacy-vs-precision tradeoff we made explicitly.
    const h = hashClient("anon");
    expect(hashClient(null)).toBe(h);
    expect(hashClient(undefined)).toBe(h);
    expect(hashClient("")).toBe(h);
    expect(hashClient("   ")).toBe(h);
  });

  it("respects the salt env var", () => {
    const before = process.env.PROXYMINER_PUBLIC_INGEST_SALT;
    try {
      process.env.PROXYMINER_PUBLIC_INGEST_SALT = "salt-A";
      const a = hashClient("203.0.113.5");
      process.env.PROXYMINER_PUBLIC_INGEST_SALT = "salt-B";
      const b = hashClient("203.0.113.5");
      expect(a).not.toBe(b);
    } finally {
      if (before === undefined) delete process.env.PROXYMINER_PUBLIC_INGEST_SALT;
      else process.env.PROXYMINER_PUBLIC_INGEST_SALT = before;
    }
  });

  it("produces a stable 24-char fingerprint", () => {
    const h = hashClient("203.0.113.5");
    expect(h).toMatch(/^[0-9a-f]{24}$/);
  });
});
