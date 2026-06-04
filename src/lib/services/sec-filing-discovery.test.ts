import { describe, expect, it, vi } from "vitest";

import {
  discoverTargetFilings,
  type SecSubmissionsBlock,
} from "./sec-filing-discovery";

const DEF = new Set(["DEF 14A"]);

function block(
  rows: { acc: string; form: string; date: string; doc?: string }[],
): SecSubmissionsBlock {
  return {
    accessionNumber: rows.map((r) => r.acc),
    form: rows.map((r) => r.form),
    filingDate: rows.map((r) => r.date),
    primaryDocument: rows.map((r) => r.doc ?? `${r.acc}.htm`),
  };
}

describe("discoverTargetFilings", () => {
  it("recent-only path is unchanged and never fetches archive when recent satisfies the limit", async () => {
    const recent = block([
      { acc: "a-26", form: "DEF 14A", date: "2026-04-16" },
      { acc: "x-8k", form: "8-K", date: "2026-03-01" },
      { acc: "a-25", form: "DEF 14A", date: "2025-04-17" },
      { acc: "a-24", form: "DEF 14A", date: "2024-04-19" },
    ]);
    const fetchArchive = vi.fn();
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "arch-1.json" }],
      limit: 2,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["a-26", "a-25"]);
    expect(fetchArchive).not.toHaveBeenCalled();
  });

  it("Meta-like: recent has 2 DEF 14A, archive supplies the 3rd", async () => {
    const recent = block([
      { acc: "m-26", form: "DEF 14A", date: "2026-04-16" },
      { acc: "8k", form: "8-K", date: "2026-01-01" },
      { acc: "m-25", form: "DEF 14A", date: "2025-04-17" },
    ]);
    const archive = block([
      { acc: "m-24", form: "DEF 14A", date: "2024-04-19" },
      { acc: "old8k", form: "8-K", date: "2024-02-01" },
      { acc: "m-23", form: "DEF 14A", date: "2023-04-20" },
    ]);
    const fetchArchive = vi.fn().mockResolvedValue(archive);
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "CIK-submissions-001.json", filingTo: "2024-12-31" }],
      limit: 3,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["m-26", "m-25", "m-24"]);
    expect(res.map((r) => r.form)).toEqual(["DEF 14A", "DEF 14A", "DEF 14A"]);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("orders newest-first across recent + archive regardless of archive ordering", async () => {
    const recent = block([{ acc: "r-25", form: "DEF 14A", date: "2025-04-17" }]);
    const archive = block([
      { acc: "a-23", form: "DEF 14A", date: "2023-04-20" },
      { acc: "a-24", form: "DEF 14A", date: "2024-04-19" },
    ]);
    const fetchArchive = vi.fn().mockResolvedValue(archive);
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "a.json" }],
      limit: 3,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["r-25", "a-24", "a-23"]);
  });

  it("ignores non-DEF 14A forms in both recent and archive", async () => {
    const recent = block([
      { acc: "pre", form: "PRE 14A", date: "2026-03-01" },
      { acc: "d-26", form: "DEF 14A", date: "2026-04-16" },
    ]);
    const archive = block([
      { acc: "defa", form: "DEFA14A", date: "2024-04-25" },
      { acc: "d-24", form: "DEF 14A", date: "2024-04-19" },
    ]);
    const fetchArchive = vi.fn().mockResolvedValue(archive);
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "a.json" }],
      limit: 5,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["d-26", "d-24"]);
  });

  it("dedupes accessions appearing in both recent and archive", async () => {
    const recent = block([
      { acc: "m-26", form: "DEF 14A", date: "2026-04-16" },
      { acc: "m-25", form: "DEF 14A", date: "2025-04-17" },
    ]);
    const archive = block([
      { acc: "m-25", form: "DEF 14A", date: "2025-04-17" },
      { acc: "m-24", form: "DEF 14A", date: "2024-04-19" },
    ]);
    const fetchArchive = vi.fn().mockResolvedValue(archive);
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "a.json" }],
      limit: 5,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["m-26", "m-25", "m-24"]);
  });

  it("reads archive files newest-first and stops once the limit is reached", async () => {
    const recent = block([{ acc: "r1", form: "DEF 14A", date: "2026-04-16" }]);
    const archNewer = block([{ acc: "a-newer", form: "DEF 14A", date: "2024-04-19" }]);
    const archOlder = block([{ acc: "a-older", form: "DEF 14A", date: "2020-04-19" }]);
    const fetchArchive = vi.fn(async (name: string) =>
      name === "newer.json" ? archNewer : archOlder,
    );
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [
        { name: "older.json", filingTo: "2020-12-31" },
        { name: "newer.json", filingTo: "2024-12-31" },
      ],
      limit: 2,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["r1", "a-newer"]);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(fetchArchive).toHaveBeenCalledWith("newer.json");
  });

  it("respects maxArchiveFiles as a fetch bound", async () => {
    const recent = block([]);
    const fetchArchive = vi.fn(async (name: string) =>
      block([{ acc: name, form: "DEF 14A", date: "2024-01-01" }]),
    );
    await discoverTargetFilings({
      recent,
      archiveFiles: [
        { name: "f4", filingTo: "2024" },
        { name: "f3", filingTo: "2023" },
        { name: "f2", filingTo: "2022" },
        { name: "f1", filingTo: "2021" },
      ],
      limit: 100,
      targetForms: DEF,
      fetchArchive,
      maxArchiveFiles: 2,
    });
    expect(fetchArchive).toHaveBeenCalledTimes(2);
  });

  it("tolerates an archive fetch failure and returns what it can", async () => {
    const recent = block([{ acc: "r1", form: "DEF 14A", date: "2026-04-16" }]);
    const fetchArchive = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await discoverTargetFilings({
      recent,
      archiveFiles: [{ name: "a.json" }],
      limit: 3,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res.map((r) => r.accession)).toEqual(["r1"]);
  });

  it("returns [] for a non-positive limit without fetching", async () => {
    const fetchArchive = vi.fn();
    const res = await discoverTargetFilings({
      recent: block([{ acc: "a", form: "DEF 14A", date: "2026-01-01" }]),
      limit: 0,
      targetForms: DEF,
      fetchArchive,
    });
    expect(res).toEqual([]);
    expect(fetchArchive).not.toHaveBeenCalled();
  });
});
