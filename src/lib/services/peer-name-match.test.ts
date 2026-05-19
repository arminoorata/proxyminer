/**
 * Peer name → SEC ticker resolution. The matcher is the load-bearing
 * piece for the live peer-panel navigation on /company/[id]; if it
 * silently mislinks, an analyst looking at Berkshire's peer list
 * could be sent to the wrong filer.
 *
 * Tests pin both halves: normalization and lookup behavior.
 */
import { describe, expect, it } from "vitest";

import type { SecTickerEntry } from "./sec-tickers-cache";
import {
  buildSecNameIndex,
  matchPeerNameToSec,
  normalizePeerName,
} from "./peer-name-match";

function mk(ticker: string, name: string, cik: string): SecTickerEntry {
  return {
    ticker,
    name,
    cik,
    ticker_lower: ticker.toLowerCase(),
    name_lower: name.toLowerCase(),
  };
}

const FIXTURE: SecTickerEntry[] = [
  mk("AAPL", "Apple Inc.", "0000320193"),
  mk("APLE", "Apple Hospitality REIT, Inc.", "0001418121"),
  mk("MSFT", "Microsoft Corp", "0000789019"),
  mk("ITW", "Illinois Tool Works Inc.", "0000049826"),
  mk("BRK-A", "Berkshire Hathaway Inc.", "0001067983"),
  mk("BRK-B", "Berkshire Hathaway Inc.", "0001067983"),
  mk("AYI", "ACUITY BRANDS INC", "0001144215"),
  mk("FTV", "Fortive Corp", "0001659166"),
  mk("HUBB", "HUBBELL INC", "0000048898"),
  mk("DOV", "DOVER CORP", "0000029905"),
];

describe("normalizePeerName", () => {
  it("strips trailing 'Inc.' / 'Inc' / 'Incorporated'", () => {
    expect(normalizePeerName("Apple Inc.")).toBe("apple");
    expect(normalizePeerName("Apple Inc")).toBe("apple");
    expect(normalizePeerName("Apple Incorporated")).toBe("apple");
  });

  it("strips 'Corp.' / 'Corporation'", () => {
    expect(normalizePeerName("Fortive Corporation")).toBe("fortive");
    expect(normalizePeerName("Fortive Corp.")).toBe("fortive");
    expect(normalizePeerName("Fortive Corp")).toBe("fortive");
  });

  it("strips 'Holdings' / 'Holding' / 'Company' / 'Companies'", () => {
    expect(normalizePeerName("Lincoln Electric Holdings, Inc.")).toBe(
      "lincoln electric",
    );
    expect(normalizePeerName("Carlisle Companies Incorporated")).toBe(
      "carlisle",
    );
  });

  it("handles & ampersand + 'Co.'", () => {
    expect(normalizePeerName("Brown & Co.")).toBe("brown");
  });

  it("is case-insensitive", () => {
    expect(normalizePeerName("ACUITY BRANDS INC")).toBe("acuity brands");
    expect(normalizePeerName("acuity brands inc")).toBe("acuity brands");
  });

  it("collapses extra whitespace + commas", () => {
    expect(normalizePeerName("  Acuity Brands,   Inc.  ")).toBe(
      "acuity brands",
    );
  });

  it("strips exchange-ticker parentheticals before matching", () => {
    // PSA-style peer rows ride this shape: "Welltower Inc. (NYSE: WELL)".
    // The parenthetical doesn't appear in SEC's title index and would
    // otherwise leak through normalization as a noisy "nyse well" tail.
    expect(normalizePeerName("Welltower Inc. (NYSE: WELL)")).toBe("welltower");
    expect(normalizePeerName("Equinix, Inc. (Nasdaq: EQIX)")).toBe("equinix");
    expect(normalizePeerName("Realty Income Corporation (NYSE: O)")).toBe(
      "realty income",
    );
    // Mixed-case + colon variants
    expect(normalizePeerName("Public Storage (nyse:psa)")).toBe(
      "public storage",
    );
    // Non-exchange parentheticals should NOT be matched by the
    // exchange-stripping regex; the trailing-suffix stripping then
    // chews "Holdings" / "Inc." normally.
    expect(normalizePeerName("Acme (Holdings) Inc.")).toBe("acme");
    // Confirm the exchange-paren strip leaves only the company name,
    // exactly like a bare "Acme Inc." would.
    expect(normalizePeerName("Acme Inc. (NYSE: ACME)")).toBe(
      normalizePeerName("Acme Inc."),
    );
  });

  it("returns empty for a bare suffix word", () => {
    // We don't want "Company" (a bare cell that slipped through
    // earlier extractors) to false-match Apple Inc. via empty
    // intermediate strings.
    expect(normalizePeerName("Company")).toBe("");
    expect(normalizePeerName("Inc.")).toBe("");
  });

  it("handles empty / null-ish input", () => {
    expect(normalizePeerName("")).toBe("");
    expect(normalizePeerName("   ")).toBe("");
  });
});

describe("matchPeerNameToSec", () => {
  const idx = buildSecNameIndex(FIXTURE);

  it("matches a clean 'X Inc.' filing-style name", () => {
    const m = matchPeerNameToSec("Apple Inc.", idx);
    expect(m?.ticker).toBe("AAPL");
    expect(m?.company_id).toBe("aapl");
  });

  it("matches with different corporate suffix forms", () => {
    expect(matchPeerNameToSec("Apple Incorporated", idx)?.ticker).toBe("AAPL");
    expect(matchPeerNameToSec("Apple Inc", idx)?.ticker).toBe("AAPL");
  });

  it("matches case-insensitively", () => {
    expect(matchPeerNameToSec("APPLE INC.", idx)?.ticker).toBe("AAPL");
  });

  it("does not collide Apple Inc. with Apple Hospitality REIT", () => {
    expect(matchPeerNameToSec("Apple Inc.", idx)?.ticker).toBe("AAPL");
    expect(matchPeerNameToSec("Apple Hospitality REIT", idx)?.ticker).toBe(
      "APLE",
    );
  });

  it("matches 'Illinois Tool Works Inc.' → ITW (real peer-list example)", () => {
    expect(matchPeerNameToSec("Illinois Tool Works Inc.", idx)?.ticker).toBe(
      "ITW",
    );
  });

  it("matches 'Berkshire Hathaway Inc.' → first share class wins", () => {
    // Both BRK-A and BRK-B share the same title. The index keeps
    // whichever was inserted first. Either is acceptable from a
    // navigation standpoint.
    const m = matchPeerNameToSec("Berkshire Hathaway Inc.", idx);
    expect(["BRK-A", "BRK-B"]).toContain(m?.ticker);
  });

  it("returns null when no SEC peer is found", () => {
    expect(matchPeerNameToSec("Madeup Holdings Inc.", idx)).toBeNull();
  });

  it("returns null on bare-suffix garbage so we don't false-match", () => {
    expect(matchPeerNameToSec("Company", idx)).toBeNull();
    expect(matchPeerNameToSec("Inc.", idx)).toBeNull();
  });

  it("matches names that differ in surrounding whitespace + commas", () => {
    expect(matchPeerNameToSec("  Acuity Brands,   Inc.  ", idx)?.ticker).toBe(
      "AYI",
    );
  });
});
