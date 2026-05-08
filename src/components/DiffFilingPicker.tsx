"use client";

/**
 * Two-dropdown filing picker for the diff route. Updates ?from= and
 * ?to= query params via shallow router push so the diff grid
 * recomputes without a full reload.
 */
import { useRouter, useSearchParams } from "next/navigation";

import type { FilingRow } from "@/lib/types";

export interface DiffFilingPickerProps {
  filings: FilingRow[];
  fromId: string;
  toId: string;
  companyId: string;
}

export default function DiffFilingPicker({
  filings,
  fromId,
  toId,
  companyId,
}: DiffFilingPickerProps) {
  const router = useRouter();
  const params = useSearchParams();

  function update(field: "from" | "to", value: string) {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set(field, value);
    router.push(`/company/${companyId}/diff?${next.toString()}`);
  }

  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <p
        className="text-[11px] font-medium uppercase tracking-[0.16em]"
        style={{ color: "var(--accent)" }}
      >
        Compare
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
          <span className="uppercase tracking-[0.12em]">From (older)</span>
          <select
            value={fromId}
            onChange={(e) => update("from", e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
            aria-label="Older filing"
          >
            {filings.map((f) => (
              <option
                key={f.id}
                value={f.id}
                disabled={f.id === toId}
                style={{ background: "var(--surface)" }}
              >
                {f.filing_year} · {f.form_type} · {f.accession_number}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
          <span className="uppercase tracking-[0.12em]">To (newer)</span>
          <select
            value={toId}
            onChange={(e) => update("to", e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
            aria-label="Newer filing"
          >
            {filings.map((f) => (
              <option
                key={f.id}
                value={f.id}
                disabled={f.id === fromId}
                style={{ background: "var(--surface)" }}
              >
                {f.filing_year} · {f.form_type} · {f.accession_number}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
