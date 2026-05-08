"use client";

/**
 * Multi-select company picker for the compare workspace. Updates the
 * `?companies=` query param via shallow router push so the comparison
 * grid re-renders without a full reload.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import type { CompanyRow } from "@/lib/types";

export interface CompanyMultiPickerProps {
  allCompanies: CompanyRow[];
  selectedIds: string[];
  maxCompanies: number;
}

export default function CompanyMultiPicker({
  allCompanies,
  selectedIds,
  maxCompanies,
}: CompanyMultiPickerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState<string[]>(selectedIds);

  const sorted = useMemo(
    () => allCompanies.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [allCompanies],
  );

  function toggle(id: string) {
    setDraft((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxCompanies) return prev;
      return [...prev, id];
    });
  }

  function apply() {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (draft.length === 0) next.delete("companies");
    else next.set("companies", draft.join(","));
    router.push(`/compare?${next.toString()}`);
  }

  function clear() {
    setDraft([]);
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("companies");
    router.push(`/compare?${next.toString()}`);
  }

  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p
          className="text-[11px] font-medium uppercase tracking-[0.16em]"
          style={{ color: "var(--accent)" }}
        >
          Select up to {maxCompanies}
        </p>
        <p className="text-[11px]" style={{ color: "var(--muted)" }}>
          {draft.length}/{maxCompanies} selected
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {sorted.map((c) => {
          const on = draft.includes(c.id);
          const disabled = !on && draft.length >= maxCompanies;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.id)}
              disabled={disabled}
              className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                on ? "border-accent" : ""
              }`}
              style={{
                borderColor: on ? "var(--accent)" : "var(--line)",
                color: on ? "var(--accent-strong)" : disabled ? "var(--muted)" : "var(--text)",
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {(c.ticker ?? c.id).toUpperCase()} · {c.name}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={draft.length === 0}
          className="btn btn-primary md:w-40"
        >
          Compare {draft.length || ""}
        </button>
        <button
          type="button"
          onClick={clear}
          className="text-[11px] uppercase tracking-[0.16em] hover:underline"
          style={{ color: "var(--muted)" }}
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}
