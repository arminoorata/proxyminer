"use client";

/**
 * Source-text search panel. Hits /api/search, renders highlighted
 * snippets, links each hit to the relevant company workspace. URL
 * state stays in sync (?q= and ?company=) so analyst search results
 * are linkable / sharable.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { splitSnippetForHighlight } from "@/lib/search/highlight";
import type { CompanyRow } from "@/lib/types";

interface SearchHit {
  company_id: string;
  company_name: string;
  filing_id: string;
  filing_year: number;
  section_type: string;
  snippet: string;
  char_offset: number;
}

interface SearchResponse {
  items: SearchHit[];
  total: number;
  truncated?: boolean;
}

function isValidHit(v: unknown): v is SearchHit {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.company_id === "string" &&
    typeof h.company_name === "string" &&
    typeof h.filing_id === "string" &&
    typeof h.filing_year === "number" &&
    typeof h.section_type === "string" &&
    typeof h.snippet === "string" &&
    typeof h.char_offset === "number"
  );
}

const SUGGESTED_QUERIES = [
  "clawback",
  "relative TSR",
  "median employee",
  "compensation committee",
  "pay ratio",
  "say on pay",
  "performance-based",
  "double-trigger",
];

export interface SearchViewProps {
  companies: CompanyRow[];
  initialQuery: string;
  initialCompany: string;
}

function highlight(snippet: string, q: string): React.ReactNode {
  // Pure split logic lives in @/lib/search/highlight so it's unit-
  // testable without React. We render each part as <mark> or <span>.
  const parts = splitSnippetForHighlight(snippet, q);
  return parts.map((part, i) =>
    part.isMatch ? (
      <mark
        key={i}
        style={{ background: "color-mix(in srgb, var(--accent) 30%, transparent)", color: "inherit" }}
      >
        {part.text}
      </mark>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  );
}

export default function SearchView({
  companies,
  initialQuery,
  initialCompany,
}: SearchViewProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(initialQuery);
  const [company, setCompany] = useState(initialCompany);
  const [items, setItems] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sortedCompanies = useMemo(
    () => companies.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );

  // Sync local state + run the search whenever the URL params change
  // (initial mount, browser back/forward, link follow). We depend on
  // searchParams' string form so referential identity tweaks in the
  // hook don't cause spurious refetches.
  const paramKey = params?.toString() ?? "";
  useEffect(() => {
    let canceled = false;
    queueMicrotask(() => {
      if (canceled) return;
      setQ(initialQuery);
      setCompany(initialCompany);
      if (initialQuery.trim().length >= 2) {
        void run(initialQuery, initialCompany);
      } else {
        setItems([]);
        setTotal(0);
        setTruncated(false);
        setError(null);
        setHasSearched(false);
      }
    });
    return () => {
      canceled = true;
    };
  }, [initialQuery, initialCompany, paramKey]);

  function syncUrl(nextQ: string, nextCompany: string) {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (nextQ) next.set("q", nextQ);
    else next.delete("q");
    if (nextCompany) next.set("company", nextCompany);
    else next.delete("company");
    router.replace(`/search?${next.toString()}`, { scroll: false });
  }

  async function run(query: string, companyId: string) {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setItems([]);
      setTotal(0);
      setTruncated(false);
      setError(null);
      setHasSearched(false);
      return;
    }
    setHasSearched(true);
    setLoading(true);
    setError(null);
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const isStale = () => abortRef.current !== ctrl;
    try {
      const url = new URL("/api/search", window.location.origin);
      url.searchParams.set("q", trimmed);
      if (companyId) url.searchParams.set("company", companyId);
      const res = await fetch(url, { signal: ctrl.signal });
      if (isStale()) return;
      if (!res.ok) {
        setError(`Search failed (${res.status}).`);
        setItems([]);
        setTotal(0);
        setTruncated(false);
      } else {
        const data = (await res.json()) as Partial<SearchResponse>;
        if (isStale()) return;
        // Validate each hit before storing — a malformed item from a
        // future API change would otherwise crash the render path.
        const safeItems = Array.isArray(data.items) ? data.items.filter(isValidHit) : [];
        setItems(safeItems);
        setTotal(typeof data.total === "number" ? data.total : safeItems.length);
        setTruncated(Boolean(data.truncated));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (isStale()) return;
      setError("Couldn't reach the search service. Retry shortly.");
      setItems([]);
      setTotal(0);
    } finally {
      // Only clear the loading flag if THIS request is still the
      // current one. A newer request would already have re-set it.
      if (!isStale()) setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    syncUrl(q, company);
    void run(q, company);
  }

  function handleSuggested(query: string) {
    setQ(query);
    syncUrl(query, company);
    void run(query, company);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 md:px-10 md:py-14">
      <header>
        <p
          className="text-xs font-medium uppercase tracking-[0.32em]"
          style={{ color: "var(--accent)" }}
        >
          ProxyMiner / Search
        </p>
        <h1 className="mt-3 text-3xl font-semibold md:text-4xl">Source-text search</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          Substring search over CD&amp;A text across every loaded filing. Use this to find specific
          disclosure language — clawback, pay ratio methodology, relative TSR phrasing — without
          guessing which company says what.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="mt-8 flex flex-col gap-3 rounded-lg border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
          <label className="flex flex-col gap-1">
            <span
              className="text-[11px] font-medium uppercase tracking-[0.18em]"
              style={{ color: "var(--accent)" }}
            >
              Query
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="clawback, relative TSR, median employee…"
              minLength={2}
              autoFocus
              className="rounded-md border bg-transparent px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span
              className="text-[11px] font-medium uppercase tracking-[0.18em]"
              style={{ color: "var(--accent)" }}
            >
              Company
            </span>
            <select
              value={company}
              onChange={(e) => {
                setCompany(e.target.value);
                syncUrl(q, e.target.value);
                if (q.trim().length >= 2) void run(q, e.target.value);
              }}
              className="rounded-md border bg-transparent px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
            >
              <option value="">All companies</option>
              {sortedCompanies.map((c) => (
                <option key={c.id} value={c.id} style={{ background: "var(--surface)" }}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary md:w-32"
            disabled={loading || q.trim().length < 2}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUERIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSuggested(s)}
              className="rounded-full border px-3 py-1 text-[11px] hover:border-accent"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              {s}
            </button>
          ))}
        </div>
      </form>

      {error ? (
        <p
          className="mt-6 rounded-md border p-3 text-sm"
          role="alert"
          style={{ borderColor: "#ef4444", color: "var(--text)" }}
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p
          className="mt-6 text-sm"
          role="status"
          aria-live="polite"
          style={{ color: "var(--muted)" }}
        >
          Searching…
        </p>
      ) : null}

      {!loading && hasSearched ? (
        <section className="mt-8">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {total === 0
              ? `No matches for "${q}"${company ? ` in ${sortedCompanies.find((c) => c.id === company)?.name ?? company}` : ""}.`
              : `${truncated ? "First " : ""}${total} match${total === 1 ? "" : "es"} for "${q}"${
                  company ? ` in ${sortedCompanies.find((c) => c.id === company)?.name ?? company}` : ""
                }${truncated ? ` (results capped — narrow the query for full coverage)` : ""}.`}
          </p>
          {items.length > 0 ? (
            <ul className="mt-4 grid grid-cols-1 gap-3">
              {items.map((hit, i) => (
                <li
                  key={`${hit.filing_id}-${hit.char_offset}-${i}`}
                  className="rounded-lg border p-4"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <a
                      href={`/company/${hit.company_id}`}
                      className="text-sm font-semibold hover:underline"
                      style={{ color: "var(--text)" }}
                    >
                      {hit.company_name}
                    </a>
                    <span
                      className="text-[11px] uppercase tracking-[0.16em]"
                      style={{ color: "var(--muted)" }}
                    >
                      {hit.filing_year} · {hit.section_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p
                    className="mt-2 text-[13px] leading-relaxed break-words"
                    style={{ color: "var(--text)" }}
                    dir="auto"
                  >
                    {highlight(hit.snippet, q)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                    <a
                      href={`/company/${hit.company_id}`}
                      className="uppercase tracking-[0.16em] hover:underline"
                      style={{ color: "var(--accent)" }}
                    >
                      Open {hit.company_name} →
                    </a>
                    <a
                      href={`/company/${hit.company_id}/diff`}
                      className="uppercase tracking-[0.16em] hover:underline"
                      style={{ color: "var(--accent)" }}
                    >
                      YoY diff →
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : !hasSearched ? (
        <p className="mt-6 text-sm" style={{ color: "var(--muted)" }}>
          Try a query above. Useful starting points include the suggested chips, but anything
          mentioned in the CD&amp;A is searchable.
        </p>
      ) : null}
    </main>
  );
}
