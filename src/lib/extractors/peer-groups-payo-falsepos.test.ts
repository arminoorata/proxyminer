/**
 * Regression test for the PAYO=BETR audit failure.
 *
 * Payoneer's proxy describes its peer-SELECTION CRITERIA with generic
 * words — "Fintech and transaction/payment processing", "publicly
 * traded ... public listing", "to better understand the competitive
 * market" — and the text extractor's single-token resolver matched each
 * to a micro-cap whose name carries the bare token:
 *   better -> BETR, fintech -> TIGR, transaction -> YTFD, public -> CRH.
 * Combined with two more prose matches that cleared the >=7-member
 * null-type guard, this emitted a bogus "peer group" on /company/payo.
 *
 * Fix: the four words are in COMMON_NAME_WORDS, so the bare single-token
 * alias never resolves. Full multi-word company names must still
 * resolve, so legitimate disclosures are unaffected.
 */
import { describe, expect, it } from "vitest";

import { extractPeerGroups, resolveCompanyName } from "./peer-groups";

describe("PAYO peer-selection-prose false positives", () => {
  it("bare criteria words no longer resolve to micro-cap tickers", () => {
    expect(resolveCompanyName("better").ticker).not.toBe("BETR");
    expect(resolveCompanyName("fintech").ticker).not.toBe("TIGR");
    expect(resolveCompanyName("transaction").ticker).not.toBe("YTFD");
    // No other company is named by just one of these generic tokens.
    expect(resolveCompanyName("better").ticker).toBeNull();
    expect(resolveCompanyName("fintech").ticker).toBeNull();
    expect(resolveCompanyName("transaction").ticker).toBeNull();
  });

  it("full multi-word company names still resolve (no over-suppression)", () => {
    expect(resolveCompanyName("Better Home & Finance Holding Co").ticker).toBe("BETR");
    expect(resolveCompanyName("UP Fintech Holding Ltd").ticker).toBe("TIGR");
    expect(resolveCompanyName("Yale Transaction Finders, Inc.").ticker).toBe("YTFD");
    // "public" was deliberately NOT blocklisted: it would have stripped
    // Public Service Enterprise Group (PEG, an S&P 500 utility). Guard
    // that PEG still resolves and is not collateral damage of this fix.
    expect(resolveCompanyName("Public Service Enterprise Group Inc").ticker).toBe("PEG");
  });

  it("a Payoneer-style criteria paragraph does not emit a bogus peer group", () => {
    // The real peer list (rendered as "Name (NASDAQ: TICKER)") is in a
    // separate block the text extractor cannot parse; only the criteria
    // prose is in range. After the fix it must yield no peer group
    // rather than a junk one built from prose words.
    const cda = [
      "Fiscal 2024 Peer Group Companies",
      "Compensia proposed a group of peer companies for purposes of comparing " +
        "our executive compensation program against the competitive market in 2024. " +
        "The companies in the compensation peer group listed below were selected on " +
        "the basis of their similarity to us using the following criteria: (i) " +
        "headquartered in the U.S. and publicly traded on a major U.S. exchange; (ii) " +
        "Fintech and transaction/payment processing and broader SaaS/Software; (iii) " +
        "similar-stage public listing timing; and consideration of peer sets to " +
        "better understand the competitive market for executive talent.",
    ].join("\n\n");
    const groups = extractPeerGroups("payo", cda);
    // The three blocklisted prose words must never surface as peers, and
    // with them gone the criteria paragraph falls below the >=7-member
    // null-type floor, so no bogus group is emitted at all.
    const badTickers = new Set(["BETR", "TIGR", "YTFD"]);
    for (const g of groups) {
      for (const m of g.members) {
        expect(badTickers.has(m.ticker_resolved ?? "")).toBe(false);
      }
    }
    expect(groups).toHaveLength(0);
  });
});
