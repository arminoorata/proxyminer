"use client";

/**
 * Combined search-and-import input. Hits /api/search/ticker with a
 * 200ms debounce, renders a dropdown of SEC matches annotated with
 * whether each is already in ProxyMiner.
 *
 * - In-DB hit  → router.push(/company/[id])
 * - Not-in-DB  → router.push(/import/[ticker]) (kicks off durable
 *                ingest via the existing flow)
 *
 * Keyboard:
 *   ↓ / ↑ — move highlight
 *   Enter — select highlighted, or fall back to the original
 *           single-field submit (so the miss-banner import CTA still
 *           catches free-form tickers that don't surface a hit)
 *   Esc   — close dropdown
 */
import { useRouter } from "next/navigation";
import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

interface Hit {
  ticker: string;
  name: string;
  cik: string;
  in_db: boolean;
  company_id: string;
  match_reason: string;
}

interface SearchResponse {
  items: Hit[];
  total: number;
  q: string;
  error?: string;
}

const DEBOUNCE_MS = 200;

export default function TickerAutocomplete({
  placeholder,
  initialValue = "",
}: {
  placeholder?: string;
  initialValue?: string;
}) {
  const router = useRouter();
  const listId = useId();
  const [q, setQ] = useState(initialValue);
  const [items, setItems] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Single search function. State mutation happens here (not inside
  // the effect body) so the `react-hooks/set-state-in-effect` rule
  // stays happy.
  const runSearch = useCallback(async (query: string) => {
    if (!query) {
      setItems([]);
      setOpen(false);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/search/ticker?q=${encodeURIComponent(query)}`,
        { signal: ctrl.signal },
      );
      if (!res.ok) {
        setItems([]);
        setOpen(true);
        return;
      }
      const data = (await res.json()) as SearchResponse;
      if (ctrl.signal.aborted) return;
      setItems(data.items ?? []);
      setHighlight(0);
      setOpen(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setItems([]);
      setOpen(true);
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  // Debounce: only schedules; setState lives in runSearch.
  useEffect(() => {
    const t = setTimeout(() => {
      void runSearch(q.trim());
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function navigateTo(hit: Hit) {
    setOpen(false);
    if (hit.in_db) {
      router.push(`/company/${hit.company_id}`);
    } else {
      router.push(`/import/${hit.company_id}`);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) {
        setOpen(true);
        setHighlight((h) => Math.min(h + 1, items.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && items.length > 0) {
        e.preventDefault();
        navigateTo(items[highlight]);
      }
      // else: fall through and let the wrapping <form> submit, so
      // the legacy "?company=X → miss banner → import CTA" path still
      // works for inputs that didn't surface a hit.
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative flex flex-1 flex-col gap-1.5 text-sm">
      <label
        htmlFor={`${listId}-input`}
        className="text-[11px] font-medium uppercase tracking-[0.18em]"
        style={{ color: "var(--accent)" }}
      >
        Company or ticker
      </label>
      <input
        id={`${listId}-input`}
        name="company"
        type="text"
        autoComplete="off"
        placeholder={placeholder ?? "Apple, AAPL, Microsoft, MSFT"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (items.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="rounded-md border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent"
        style={{ borderColor: "var(--line)", color: "var(--text)" }}
      />
      {open && (q.trim().length > 0) ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-20 max-h-80 overflow-y-auto rounded-md border shadow-lg"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
          }}
        >
          {loading && items.length === 0 ? (
            <li
              className="px-3 py-2 text-sm"
              style={{ color: "var(--muted)" }}
            >
              Searching…
            </li>
          ) : items.length === 0 ? (
            <li
              className="px-3 py-2 text-sm"
              style={{ color: "var(--muted)" }}
            >
              No SEC company matches &ldquo;{q}&rdquo;. Press Enter to
              search ProxyMiner anyway.
            </li>
          ) : (
            items.map((hit, i) => (
              <li
                key={`${hit.ticker}-${hit.cik}`}
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  navigateTo(hit);
                }}
                className="cursor-pointer px-3 py-2 text-sm"
                style={{
                  background:
                    i === highlight
                      ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                      : "transparent",
                  color: "var(--text)",
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-semibold">{hit.ticker}</span>
                    <span
                      className="ml-2 truncate"
                      style={{ color: "var(--muted)" }}
                    >
                      {hit.name}
                    </span>
                  </div>
                  <span
                    className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]"
                    style={{
                      borderColor: hit.in_db ? "var(--accent)" : "var(--line)",
                      color: hit.in_db ? "var(--accent)" : "var(--muted)",
                    }}
                  >
                    {hit.in_db ? "In ProxyMiner" : "Import from SEC"}
                  </span>
                </div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
