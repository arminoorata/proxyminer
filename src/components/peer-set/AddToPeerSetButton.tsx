"use client";

/**
 * A toggle button that adds/removes a company from the analyst's
 * working peer set. Three render variants matching the surfaces it
 * lives on:
 *
 *   - "header" — full button with label, for the company page hero
 *   - "chip"   — inline pill, for peer-group chips (when we want a
 *                separate + button NEXT to a chip-link)
 *   - "icon"   — square icon-only, for compact contexts
 *
 * State is purely client-side (localStorage). No network. Optimistic.
 */
import { usePeerSet } from "./use-peer-set";

interface AddToPeerSetButtonProps {
  companyId: string;
  ticker?: string | null;
  name?: string | null;
  /** If true, mark the entry as still-importable on add. */
  importable?: boolean;
  variant?: "header" | "chip" | "icon";
}

export default function AddToPeerSetButton({
  companyId,
  ticker = null,
  name = null,
  importable = false,
  variant = "header",
}: AddToPeerSetButtonProps) {
  const { has, add, remove, ready } = usePeerSet();
  const id = companyId.toLowerCase();
  const inSet = ready && has(id);

  function toggle() {
    if (inSet) remove(id);
    else add(id, { ticker, name, importable });
  }

  const label = variant === "header"
    ? inSet ? "In peer set ✓" : "+ Add to peer set"
    : inSet ? "✓" : "+";
  const title = inSet
    ? `Remove ${ticker ?? id.toUpperCase()} from peer set`
    : `Add ${ticker ?? id.toUpperCase()} to peer set`;

  if (variant === "header") {
    return (
      <button
        type="button"
        onClick={toggle}
        title={title}
        className="rounded-md border px-3 py-1.5 text-xs uppercase tracking-[0.16em] hover:border-accent"
        style={{
          borderColor: inSet ? "var(--accent)" : "var(--line)",
          color: inSet ? "var(--accent)" : "var(--text)",
        }}
      >
        {label}
      </button>
    );
  }

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        title={title}
        aria-label={title}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] leading-none hover:border-accent"
        style={{
          borderColor: inSet ? "var(--accent)" : "var(--line)",
          color: inSet ? "var(--accent)" : "var(--muted)",
        }}
      >
        {label}
      </button>
    );
  }

  // chip
  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] hover:border-accent"
      style={{
        borderColor: inSet ? "var(--accent)" : "var(--line)",
        color: inSet ? "var(--accent)" : "var(--muted)",
      }}
    >
      {label}
    </button>
  );
}
