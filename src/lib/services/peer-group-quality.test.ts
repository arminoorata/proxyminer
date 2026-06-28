import { describe, expect, it } from "vitest";

import { auditPeerGroupQuality, classifyPeerMember } from "./peer-group-quality";

function member(ticker: string | null) {
  return {
    company_id_resolved: ticker ? ticker.toLowerCase() : null,
    ticker_resolved: ticker,
  };
}

describe("peer-group quality audit", () => {
  it("flags a PAYO=BETR-style suspect peer group before it can render publicly", () => {
    const quality = auditPeerGroupQuality("payo", [
      member("AAPL"),
      member("BETR"),
      member("MSFT"),
    ]);

    expect(quality).toEqual({
      reviewStatus: "flagged",
      verificationStatus: "rejected",
      reviewNotes: "Auto-quarantined peer group: suspect ticker(s) BETR.",
      suspectTickers: ["BETR"],
    });
  });

  it("keeps confirmed legitimate parent/peer pairs out of quarantine", () => {
    expect(classifyPeerMember("fang", member("EXE"))).toBe("legit-allowlist");
    expect(auditPeerGroupQuality("fang", [member("EXE")]).reviewStatus).toBe(
      "unreviewed",
    );
  });

  it("normalizes lowercase resolved company IDs when ticker_resolved is absent", () => {
    const quality = auditPeerGroupQuality("crm", [
      { company_id_resolved: "heps", ticker_resolved: null },
    ]);

    expect(quality.reviewStatus).toBe("flagged");
    expect(quality.suspectTickers).toEqual(["HEPS"]);
  });

  it("leaves clean peer groups machine-extracted and public-reviewable", () => {
    const quality = auditPeerGroupQuality("adbe", [
      member("PANW"),
      member("MSFT"),
      member("ORCL"),
    ]);

    expect(quality.reviewStatus).toBe("unreviewed");
    expect(quality.verificationStatus).toBe("machine_extracted");
    expect(quality.reviewNotes).toBeNull();
    expect(quality.suspectTickers).toEqual([]);
  });
});
