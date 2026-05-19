"use client";

/**
 * One-click CSV export of the compare grid. Delegates the actual
 * shape to the shared CSV builder in lib/peer-set so the server-side
 * peer-set export and the in-page compare export stay identical.
 */
import type { ColumnPayload } from "@/lib/peer-set/csv-payload";
import { buildPeerSetCsv } from "@/lib/peer-set/csv";

export default function CompareCsvButton({ columns }: { columns: ColumnPayload[] }) {
  function download() {
    const csv = buildPeerSetCsv(columns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `proxyminer-compare-${columns
      .map((c) => c.companyId)
      .join("-")}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-md border px-3 py-1.5 text-[12px] uppercase tracking-[0.16em] hover:border-accent"
      style={{ borderColor: "var(--line)", color: "var(--text)" }}
    >
      Export CSV
    </button>
  );
}
