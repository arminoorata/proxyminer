"use client";

/**
 * Sticky workspace tray. Hidden until the analyst adds the first
 * company; thereafter pinned to the bottom-right with a count badge.
 * Click to expand into a list with per-entry remove + bulk actions
 * (compare, export CSV, clear).
 *
 * Why bottom-right and not the header: the header is a navigation
 * surface; this is a working-state surface. Keeping them visually
 * distinct prevents the "compare for X" button from being confused
 * with a nav link.
 *
 * Export: opens GET /api/peerset/export?companies=... in a new tab.
 * The server endpoint reuses the same column shape as the compare
 * page so the CSV matches what an analyst sees on screen.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { entriesToCompareCsv } from "@/lib/peer-set/storage";
import { usePeerSet } from "./use-peer-set";

const COMPARE_CAP = 6;

export default function PeerSetTray() {
  const { set, remove, clear, ready, entries } = usePeerSet();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const panelId = useId();

  // Phase 29 a11y: Escape closes the expanded tray. The tray is a
  // bottom-right overlay; without an Escape handler a keyboard user
  // has to tab to the × button to dismiss it. Bound to document so
  // the panel doesn't need to hold focus.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Suppress entirely on first paint to avoid SSR/CSR mismatch + any
  // count flicker. Once hydrated, only render when non-empty.
  if (!ready || entries.length === 0) return null;

  const importableCount = entries.filter((e) => e.importable).length;
  const compareIds = entriesToCompareCsv(set, COMPARE_CAP);
  const canCompare = entries.length >= 2;

  function openCompare() {
    router.push(`/compare?companies=${compareIds}`);
    setOpen(false);
  }

  function downloadCsv() {
    const ids = entries.map((e) => e.id).join(",");
    const url = `/api/peerset/export?companies=${encodeURIComponent(ids)}`;
    window.open(url, "_blank");
  }

  return (
    <aside
      className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)]"
      aria-label="Peer set workspace"
    >
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Peer set tray"
          className="rounded-lg border shadow-xl"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            width: "min(360px, calc(100vw - 2rem))",
          }}
        >
          <header
            className="flex items-center justify-between gap-2 border-b px-4 py-3"
            style={{ borderColor: "var(--line)" }}
          >
            <div>
              <p
                className="text-[10px] font-medium uppercase tracking-[0.18em]"
                style={{ color: "var(--accent)" }}
              >
                Peer set
              </p>
              <p className="text-sm" style={{ color: "var(--text)" }}>
                {entries.length} {entries.length === 1 ? "company" : "companies"}
                {importableCount > 0 ? (
                  <span style={{ color: "var(--muted)" }}>
                    {" "}· {importableCount} importable
                  </span>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close peer set tray"
              className="rounded-md border px-2 py-1 text-xs hover:border-accent"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              ×
            </button>
          </header>

          <ul
            className="max-h-64 overflow-y-auto px-2 py-2"
            style={{ color: "var(--text)" }}
          >
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
              >
                {e.importable ? (
                  <Link
                    href={`/import/${e.id}`}
                    className="min-w-0 flex-1 truncate"
                    title={`Import ${e.ticker ?? e.id.toUpperCase()} from SEC`}
                  >
                    <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                      {e.ticker ?? e.id.toUpperCase()}
                    </span>
                    {e.name ? (
                      <span className="ml-2 truncate" style={{ color: "var(--text)" }}>
                        {e.name}
                      </span>
                    ) : null}
                    <span
                      className="ml-2 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
                      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                    >
                      Import
                    </span>
                  </Link>
                ) : (
                  <Link
                    href={`/company/${e.id}`}
                    className="min-w-0 flex-1 truncate"
                    title={`Open ${e.ticker ?? e.id.toUpperCase()}`}
                  >
                    <span className="font-mono text-xs" style={{ color: "var(--accent)" }}>
                      {e.ticker ?? e.id.toUpperCase()}
                    </span>
                    {e.name ? (
                      <span className="ml-2 truncate" style={{ color: "var(--text)" }}>
                        {e.name}
                      </span>
                    ) : null}
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => remove(e.id)}
                  aria-label={`Remove ${e.ticker ?? e.id.toUpperCase()} from peer set`}
                  className="rounded border px-1.5 text-[10px] text-[var(--muted)] hover:border-accent"
                  style={{ borderColor: "var(--line)" }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div
            className="flex flex-wrap gap-2 border-t px-4 py-3"
            style={{ borderColor: "var(--line)" }}
          >
            <button
              type="button"
              onClick={openCompare}
              disabled={!canCompare}
              aria-describedby={!canCompare ? `${panelId}-compare-hint` : undefined}
              className="rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
              title={
                !canCompare
                  ? "Add at least 2 companies to compare"
                  : entries.length > COMPARE_CAP
                    ? `Compare shows the first ${COMPARE_CAP}; CSV exports all ${entries.length}.`
                    : "Open in compare grid"
              }
            >
              Compare ({Math.min(entries.length, COMPARE_CAP)})
            </button>
            {!canCompare ? (
              <p
                id={`${panelId}-compare-hint`}
                className="basis-full text-[10px]"
                style={{ color: "var(--muted)" }}
              >
                Add at least 2 companies to enable compare.
              </p>
            ) : null}
            <button
              type="button"
              onClick={downloadCsv}
              className="rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:border-accent"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              title="Export the full peer set as CSV (no compare-page cap)"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => {
                if (entries.length === 0) return;
                // Always confirm clear — it's a destructive bulk action.
                if (window.confirm(`Clear all ${entries.length} from the peer set?`)) {
                  clear();
                }
              }}
              className="ml-auto rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:border-accent"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border px-4 py-2 text-xs font-medium shadow-lg hover:border-accent"
          style={{
            borderColor: "var(--accent)",
            background: "var(--surface)",
            color: "var(--text)",
          }}
          aria-expanded={false}
          aria-controls={panelId}
          aria-label={`Open peer set tray (${entries.length} ${entries.length === 1 ? "company" : "companies"})`}
        >
          <span style={{ color: "var(--accent)" }}>●</span> Peer set ·{" "}
          {entries.length}
        </button>
      )}
    </aside>
  );
}
