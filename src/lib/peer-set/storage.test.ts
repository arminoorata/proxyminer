/**
 * Pure peer-set state helpers. The React hook layers state + storage
 * on top; here we just pin the data invariants.
 */
import { describe, expect, it } from "vitest";

import {
  addEntry,
  clearSet,
  emptyPeerSet,
  entriesToAllIds,
  entriesToCompareCsv,
  hasEntry,
  markImported,
  parsePeerSet,
  PEER_SET_MAX_ENTRIES,
  removeEntry,
  serializePeerSet,
} from "./storage";

describe("addEntry", () => {
  it("adds a fresh id", () => {
    const s = addEntry(emptyPeerSet(), "AAPL", {
      ticker: "AAPL",
      name: "Apple Inc.",
    });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].id).toBe("aapl"); // lowercased
    expect(s.entries[0].ticker).toBe("AAPL");
    expect(s.entries[0].name).toBe("Apple Inc.");
    expect(s.entries[0].importable).toBe(false);
  });

  it("dedupes — adding the same id twice leaves length=1", () => {
    let s = addEntry(emptyPeerSet(), "aapl", {
      ticker: "AAPL",
      name: "Apple Inc.",
    });
    s = addEntry(s, "AAPL", { ticker: "AAPL", name: "Apple Inc." });
    expect(s.entries).toHaveLength(1);
  });

  it("updates display fields on re-add but preserves position", () => {
    let s = addEntry(emptyPeerSet(), "msft", {
      ticker: "MSFT",
      name: "Microsoft Corp",
    });
    s = addEntry(s, "aapl", { ticker: "AAPL", name: "Apple Inc." });
    // Re-add msft with a richer name — should not jump to front.
    s = addEntry(s, "msft", { name: "Microsoft Corporation" });
    expect(s.entries.map((e) => e.id)).toEqual(["msft", "aapl"]);
    expect(s.entries[0].name).toBe("Microsoft Corporation");
  });

  it("re-add with importable=false locks the in-DB flag", () => {
    let s = addEntry(emptyPeerSet(), "abc", { importable: true });
    expect(s.entries[0].importable).toBe(true);
    s = addEntry(s, "abc", { importable: false });
    expect(s.entries[0].importable).toBe(false);
  });

  it("rejects empty id", () => {
    const s = addEntry(emptyPeerSet(), "");
    expect(s.entries).toHaveLength(0);
  });

  it("caps at PEER_SET_MAX_ENTRIES — silently drops excess", () => {
    let s = emptyPeerSet();
    for (let i = 0; i < PEER_SET_MAX_ENTRIES + 5; i++) {
      s = addEntry(s, `t${i}`);
    }
    expect(s.entries).toHaveLength(PEER_SET_MAX_ENTRIES);
    expect(s.entries[0].id).toBe("t0");
  });
});

describe("removeEntry / clearSet / hasEntry", () => {
  it("removes by id (case-insensitive)", () => {
    let s = addEntry(emptyPeerSet(), "aapl");
    s = addEntry(s, "msft");
    s = removeEntry(s, "AAPL");
    expect(s.entries.map((e) => e.id)).toEqual(["msft"]);
  });

  it("remove of unknown id is a no-op", () => {
    const s = addEntry(emptyPeerSet(), "aapl");
    expect(removeEntry(s, "zzz").entries).toHaveLength(1);
  });

  it("clearSet wipes entries but keeps version", () => {
    let s = addEntry(emptyPeerSet(), "aapl");
    s = addEntry(s, "msft");
    s = clearSet(s);
    expect(s.entries).toEqual([]);
    expect(s.version).toBe(1);
  });

  it("hasEntry is case-insensitive", () => {
    const s = addEntry(emptyPeerSet(), "aapl");
    expect(hasEntry(s, "AAPL")).toBe(true);
    expect(hasEntry(s, "msft")).toBe(false);
  });
});

describe("markImported", () => {
  it("flips importable=true entries to false for ids in the set", () => {
    let s = addEntry(emptyPeerSet(), "aapl", { importable: true });
    s = addEntry(s, "msft", { importable: true });
    s = addEntry(s, "googl", { importable: true });
    s = markImported(s, new Set(["aapl", "msft"]));
    const byId = new Map(s.entries.map((e) => [e.id, e.importable]));
    expect(byId.get("aapl")).toBe(false);
    expect(byId.get("msft")).toBe(false);
    expect(byId.get("googl")).toBe(true);
  });

  it("returns same reference when nothing is importable", () => {
    const s = addEntry(emptyPeerSet(), "aapl");
    expect(markImported(s, new Set(["aapl"]))).toBe(s);
  });
});

describe("entriesToCompareCsv / entriesToAllIds", () => {
  it("entriesToCompareCsv caps at 6 by default", () => {
    let s = emptyPeerSet();
    for (let i = 0; i < 10; i++) s = addEntry(s, `t${i}`);
    const csv = entriesToCompareCsv(s);
    expect(csv.split(",")).toHaveLength(6);
    expect(csv).toBe("t0,t1,t2,t3,t4,t5");
  });

  it("entriesToAllIds returns lowercase insertion-order ids", () => {
    let s = addEntry(emptyPeerSet(), "AAPL");
    s = addEntry(s, "MSFT");
    expect(entriesToAllIds(s)).toEqual(["aapl", "msft"]);
  });
});

describe("parsePeerSet / serializePeerSet round-trip", () => {
  it("serialize → parse preserves entries", () => {
    let s = addEntry(emptyPeerSet(), "aapl", {
      ticker: "AAPL",
      name: "Apple Inc.",
    });
    s = addEntry(s, "msft", { ticker: "MSFT", name: "Microsoft", importable: true });
    const round = parsePeerSet(serializePeerSet(s));
    expect(round.entries).toHaveLength(2);
    expect(round.entries[0].id).toBe("aapl");
    expect(round.entries[1].importable).toBe(true);
  });

  it("parses an empty / missing input as empty set", () => {
    expect(parsePeerSet(null).entries).toEqual([]);
    expect(parsePeerSet("").entries).toEqual([]);
    expect(parsePeerSet(undefined).entries).toEqual([]);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(parsePeerSet("{not json").entries).toEqual([]);
    expect(parsePeerSet("[]").entries).toEqual([]); // wrong root shape
    expect(parsePeerSet('{"version":2,"entries":[]}').entries).toEqual([]); // wrong version
  });

  it("dedupes duplicates encountered while parsing", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { id: "aapl", ticker: "AAPL" },
        { id: "AAPL", ticker: "AAPL", name: "Apple Inc." },
      ],
    });
    expect(parsePeerSet(raw).entries).toHaveLength(1);
  });

  it("drops entries without a string id", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { id: "aapl" },
        { ticker: "MSFT" }, // missing id
        { id: 42 }, // wrong type
      ],
    });
    expect(parsePeerSet(raw).entries.map((e) => e.id)).toEqual(["aapl"]);
  });
});
