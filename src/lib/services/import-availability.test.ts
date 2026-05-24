/**
 * Phase 22 — public import quota/degraded UX.
 *
 * Pins three contracts that the homepage autocomplete and the
 * /import/[ticker] runner both depend on:
 *
 *   1. When SEC search degrades to the bundled fallback, hits NOT
 *      already in the DB must be classified "unavailable_degraded"
 *      so the UI doesn't queue an ingest job that's guaranteed to
 *      fail under Vercel data-transfer quota.
 *
 *   2. When the same search is degraded but the hit IS already in
 *      the DB, navigation to /company/[id] must still be allowed —
 *      the quota only affects new imports, not existing companies.
 *
 *   3. The ingest error classifier must collapse all platform-quota
 *      shaped errors (typed code + free-text message detection) into
 *      a single bucket so the ImportRunner can hide the Retry button.
 */
import { describe, expect, it } from "vitest";

import {
  PLATFORM_QUOTA_MESSAGE,
  buildAutocompleteAriaLabel,
  classifyImportAvailability,
  classifyImportError,
  isPlatformQuotaMessage,
  nextNavigableIndex,
} from "./import-availability";

describe("classifyImportAvailability (Phase 22)", () => {
  it("degraded + not_in_db → unavailable_degraded (no import offered)", () => {
    expect(classifyImportAvailability({ in_db: false }, true)).toBe(
      "unavailable_degraded",
    );
  });

  it("degraded + in_db → in_db (existing company still navigable)", () => {
    expect(classifyImportAvailability({ in_db: true }, true)).toBe("in_db");
  });

  it("live + not_in_db → available (normal import path)", () => {
    expect(classifyImportAvailability({ in_db: false }, false)).toBe(
      "available",
    );
  });

  it("live + in_db → in_db", () => {
    expect(classifyImportAvailability({ in_db: true }, false)).toBe("in_db");
  });
});

describe("isPlatformQuotaMessage (Phase 22)", () => {
  it("matches the exact Vercel quota message", () => {
    expect(
      isPlatformQuotaMessage(
        "Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.",
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isPlatformQuotaMessage("DATA TRANSFER QUOTA exceeded")).toBe(true);
  });

  it("does not match generic SEC failures", () => {
    expect(
      isPlatformQuotaMessage("SEC fetch failed (503): https://www.sec.gov/..."),
    ).toBe(false);
  });

  it("does not match empty / null", () => {
    expect(isPlatformQuotaMessage(null)).toBe(false);
    expect(isPlatformQuotaMessage(undefined)).toBe(false);
    expect(isPlatformQuotaMessage("")).toBe(false);
  });
});

describe("classifyImportError (Phase 22)", () => {
  it("typed platform_quota_exceeded → platform_quota", () => {
    expect(
      classifyImportError({
        code: "platform_quota_exceeded",
        message: PLATFORM_QUOTA_MESSAGE,
      }),
    ).toBe("platform_quota");
  });

  it("untyped error with quota-shaped message → platform_quota", () => {
    expect(
      classifyImportError({
        code: "http_503",
        message:
          "Your project has exceeded the data transfer quota. Upgrade your plan.",
      }),
    ).toBe("platform_quota");
  });

  it("sec_fetch_failed (no quota message) → sec_transient", () => {
    expect(
      classifyImportError({
        code: "sec_fetch_failed",
        message: "SEC EDGAR returned 502.",
      }),
    ).toBe("sec_transient");
  });

  it("client_cap → other (real rate-limit shouldn't read as platform quota)", () => {
    expect(
      classifyImportError({
        code: "client_cap",
        message: "You've imported 5 companies in the last hour.",
      }),
    ).toBe("other");
  });

  it("invalid_ticker → other", () => {
    expect(
      classifyImportError({
        code: "invalid_ticker",
        message: "Ticker shape rejected.",
      }),
    ).toBe("other");
  });
});

describe("buildAutocompleteAriaLabel (Phase 26 a11y)", () => {
  it("in_db hits announce ticker, name, and 'press Enter to open'", () => {
    const label = buildAutocompleteAriaLabel(
      { ticker: "AAPL", name: "Apple Inc." },
      "in_db",
    );
    expect(label).toContain("AAPL");
    expect(label).toContain("Apple Inc.");
    expect(label).toContain("in ProxyMiner");
    expect(label).toContain("Press Enter to open");
  });

  it("available (not-in-db, live) hits announce 'import from SEC'", () => {
    const label = buildAutocompleteAriaLabel(
      { ticker: "APPF", name: "AppFolio Inc." },
      "available",
    );
    expect(label).toContain("APPF");
    expect(label).toContain("AppFolio Inc.");
    expect(label).toContain("import from SEC");
  });

  it("unavailable_degraded hits announce WHY Enter does nothing", () => {
    // The crucial a11y case: without this, a screen-reader user
    // tabbing the listbox under degraded mode hears "APPF AppFolio
    // Inc." but has no way to know Enter is a no-op for them.
    const label = buildAutocompleteAriaLabel(
      { ticker: "APPF", name: "AppFolio Inc." },
      "unavailable_degraded",
    );
    expect(label).toContain("APPF");
    expect(label).toContain("unavailable");
    expect(label).toContain("SEC imports are paused");
  });

  it("returned label includes both ticker and name for every availability", () => {
    for (const a of ["available", "in_db", "unavailable_degraded"] as const) {
      const label = buildAutocompleteAriaLabel(
        { ticker: "XYZ", name: "Example Co" },
        a,
      );
      expect(label.startsWith("XYZ Example Co"), `availability=${a}`).toBe(true);
    }
  });
});

describe("nextNavigableIndex (Phase 28 keyboard skip-over)", () => {
  // Modeling rows as `1 | 0` — 1 = navigable, 0 = unavailable.
  const ok = (n: number) => n === 1;

  it("ArrowDown advances to the next row when all are navigable", () => {
    const items = [1, 1, 1];
    expect(nextNavigableIndex(items, 0, 1, ok)).toBe(1);
    expect(nextNavigableIndex(items, 1, 1, ok)).toBe(2);
  });

  it("ArrowUp moves backward when all are navigable", () => {
    const items = [1, 1, 1];
    expect(nextNavigableIndex(items, 2, -1, ok)).toBe(1);
    expect(nextNavigableIndex(items, 1, -1, ok)).toBe(0);
  });

  it("ArrowDown wraps to index 0 from the last row", () => {
    // Standard combobox keyboard convention: ArrowDown past the end
    // wraps to the top. Without this, a user on the last available
    // row can't get back to the top without Shift+Home.
    expect(nextNavigableIndex([1, 1, 1], 2, 1, ok)).toBe(0);
  });

  it("ArrowUp wraps to the last row from index 0", () => {
    expect(nextNavigableIndex([1, 1, 1], 0, -1, ok)).toBe(2);
  });

  it("ArrowDown skips a single unavailable row in the middle", () => {
    // [AAPL, APPF*, MSFT] — pressing ArrowDown from AAPL should land
    // on MSFT, not APPF. Visual feedback still shows APPF greyed.
    expect(nextNavigableIndex([1, 0, 1], 0, 1, ok)).toBe(2);
  });

  it("ArrowDown skips a run of unavailable rows", () => {
    // [AAPL, APPF*, ZZZZ*, MSFT] — skip both APPF and ZZZZ.
    expect(nextNavigableIndex([1, 0, 0, 1], 0, 1, ok)).toBe(3);
  });

  it("ArrowUp also skips unavailable rows", () => {
    // [AAPL, APPF*, MSFT] — pressing ArrowUp from MSFT skips APPF and
    // lands on AAPL.
    expect(nextNavigableIndex([1, 0, 1], 2, -1, ok)).toBe(0);
  });

  it("when EVERY row is unavailable, returns the current index unchanged", () => {
    // [APPF*, ZZZZ*] — nothing to navigate to. The current index stays
    // put and the aria-disabled state on each row tells the screen
    // reader why.
    expect(nextNavigableIndex([0, 0], 0, 1, ok)).toBe(0);
    expect(nextNavigableIndex([0, 0], 1, -1, ok)).toBe(1);
  });

  it("empty list returns 0", () => {
    expect(nextNavigableIndex([], 0, 1, ok)).toBe(0);
  });

  it("wraps past trailing unavailable rows to find the first navigable one", () => {
    // [APPF*, AAPL, ZZZZ*, YYYY*] — ArrowDown from APPF should land
    // on AAPL even though the wrap path crosses two more unavailable
    // rows.
    expect(nextNavigableIndex([0, 1, 0, 0], 0, 1, ok)).toBe(1);
    // ArrowDown from AAPL with no other navigable row wraps back to
    // AAPL (current).
    expect(nextNavigableIndex([0, 1, 0, 0], 1, 1, ok)).toBe(1);
  });

  it("realistic degraded-mode scenario: 3 unavailable + 1 in-db at index 3", () => {
    const items = [
      { availability: "unavailable_degraded" as const },
      { availability: "unavailable_degraded" as const },
      { availability: "unavailable_degraded" as const },
      { availability: "in_db" as const },
    ];
    const idx = nextNavigableIndex(
      items,
      0,
      1,
      (item) => item.availability !== "unavailable_degraded",
    );
    expect(idx).toBe(3);
  });
});
