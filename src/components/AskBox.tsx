"use client";

/**
 * BYOK Ask interface for the company workspace. The user pastes their
 * Google AI Studio key once (stored in localStorage), then asks
 * questions scoped to the loaded company + filing. Answers come back
 * with citations binding every claim to a structured artifact in the
 * loaded context.
 *
 * Mirrors equity.arminoorata.com's Ask pattern: free for everyone,
 * key never persists server-side, citations are first-class.
 */
import { useEffect, useState } from "react";

interface Citation {
  kind: string;
  filing_id: string;
  excerpt: string;
  ref: Record<string, unknown>;
}

interface Answer {
  title: string;
  summary: string;
  bullets: string[];
  citations: Citation[];
  scope_note: string;
  scope_explanation?: string | null;
}

interface QA {
  id: string;
  question: string;
  answer: Answer | null;
  error: string | null;
  loading: boolean;
}

const KEY_STORAGE = "proxyminer_gemini_key";
const HISTORY_STORAGE_PREFIX = "proxyminer_ask_history_";
const MAX_HISTORY = 20;

const SUGGESTED_PROMPTS = [
  "What is the compensation philosophy?",
  "Summarize the long-term incentive plan design.",
  "Who is on the compensation committee and how is it disclosed?",
  "What are the performance metrics and weightings for the annual bonus?",
  "How did pay change year over year for the CEO?",
  "What governance practices around clawback, hedging, and pledging are disclosed?",
];

export interface AskBoxProps {
  companyId: string;
  companyName: string;
  filingId: string;
  filingYear: number;
}

function citationLabel(c: Citation): string {
  const ref = c.ref as Record<string, string | number | undefined>;
  switch (c.kind) {
    case "executive_comp":
      return `${ref.executive_name} · ${ref.year} · ${String(ref.field).replace(/_/g, " ")}`;
    case "policy_fact":
      return `Policy: ${String(ref.policy_type).replace(/_/g, " ")}`;
    case "metric_fact":
      return `Metric: ${String(ref.metric_name_normalized).replace(/_/g, " ")}`;
    case "peer_group":
      return `Peer group${ref.peer_group_name ? ` · ${ref.peer_group_name}` : ""}`;
    case "peer_member":
      return `Peer member: ${ref.company_name_raw}`;
    case "section_excerpt":
      return `${String(ref.section_type).replace(/_/g, " ")} excerpt`;
    case "filing_metadata":
      return `Filing · ${String(ref.field).replace(/_/g, " ")}`;
    default:
      return c.kind;
  }
}

function scopeNoteCopy(note: string): { tone: "ok" | "warn" | "stop"; label: string } {
  switch (note) {
    case "in_scope":
      return { tone: "ok", label: "In scope" };
    case "partial_out_of_scope":
      return { tone: "warn", label: "Partially out of scope" };
    case "needs_data_we_don_t_have":
      return { tone: "warn", label: "Needs data not in this filing" };
    case "interpretive":
      return { tone: "warn", label: "Interpretive" };
    case "refused":
      return { tone: "stop", label: "Out of scope" };
    default:
      return { tone: "ok", label: note };
  }
}

export default function AskBox({ companyId, companyName, filingId, filingYear }: AskBoxProps) {
  const [apiKey, setApiKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKeyEdit, setShowKeyEdit] = useState(false);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load key + per-company history from localStorage on mount.
  useEffect(() => {
    try {
      const k = window.localStorage.getItem(KEY_STORAGE) ?? "";
      setApiKey(k);
      const h = window.localStorage.getItem(HISTORY_STORAGE_PREFIX + companyId);
      if (h) setHistory(JSON.parse(h) as QA[]);
    } catch {
      /* localStorage may be disabled — silently degrade */
    }
    setLoaded(true);
  }, [companyId]);

  // Persist history on change.
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(
        HISTORY_STORAGE_PREFIX + companyId,
        JSON.stringify(history.slice(-MAX_HISTORY)),
      );
    } catch {
      /* ignore */
    }
  }, [history, companyId, loaded]);

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (trimmed.length < 20) return;
    try {
      window.localStorage.setItem(KEY_STORAGE, trimmed);
    } catch {
      /* ignore */
    }
    setApiKey(trimmed);
    setKeyDraft("");
    setShowKeyEdit(false);
  }

  function clearKey() {
    try {
      window.localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore */
    }
    setApiKey("");
    setShowKeyEdit(true);
  }

  async function ask(promptText: string) {
    const text = promptText.trim();
    if (text.length < 2 || !apiKey) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const placeholder: QA = {
      id,
      question: text,
      answer: null,
      error: null,
      loading: true,
    };
    setHistory((prev) => [...prev, placeholder]);
    setQuestion("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: text,
          company_id: companyId,
          filing_id: filingId,
          gemini_api_key: apiKey,
        }),
      });
      const data = (await res.json()) as Answer & { error?: string };
      setHistory((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                loading: false,
                error: data.error ?? null,
                answer: data.error ? null : (data as Answer),
              }
            : q,
        ),
      );
    } catch (err) {
      setHistory((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                loading: false,
                error: err instanceof Error ? err.message : "Request failed",
              }
            : q,
        ),
      );
    }
  }

  function clearHistory() {
    setHistory([]);
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_PREFIX + companyId);
    } catch {
      /* ignore */
    }
  }

  if (!loaded) return null;

  const needsKey = !apiKey || showKeyEdit;

  return (
    <section
      className="rounded-lg border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      aria-label={`Ask about ${companyName}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p
            className="text-[11px] font-medium uppercase tracking-[0.18em]"
            style={{ color: "var(--accent)" }}
          >
            Ask
          </p>
          <h2 className="mt-1 text-2xl font-semibold">
            Anything about {companyName}&rsquo;s {filingYear} proxy
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Answers are grounded in the loaded filing and cite specific artifacts. Bring your own
            free Google AI Studio key.
          </p>
        </div>
        {apiKey && !showKeyEdit ? (
          <button
            type="button"
            onClick={() => setShowKeyEdit(true)}
            className="text-[11px] uppercase tracking-[0.16em] hover:underline"
            style={{ color: "var(--muted)" }}
          >
            Change key
          </button>
        ) : null}
      </div>

      {needsKey ? (
        <div
          className="mt-5 rounded-md border p-4"
          style={{ borderColor: "var(--line)", background: "var(--surface-alt)" }}
        >
          <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
            Bring your own Google AI Studio key
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            Get a free key at{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: "var(--accent)" }}
            >
              aistudio.google.com/apikey
            </a>
            . The key is stored only in this browser&rsquo;s localStorage. ProxyMiner forwards it to
            Google for the request and discards it; it is never written to the database.
          </p>
          <div className="mt-3 flex flex-col gap-2 md:flex-row">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="AIza…"
              className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={saveKey}
              disabled={keyDraft.trim().length < 20}
              className="btn btn-primary md:w-32"
            >
              Save key
            </button>
            {apiKey ? (
              <button
                type="button"
                onClick={() => {
                  setShowKeyEdit(false);
                  setKeyDraft("");
                }}
                className="text-[11px] uppercase tracking-[0.16em] hover:underline"
                style={{ color: "var(--muted)" }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {apiKey ? (
            <button
              type="button"
              onClick={clearKey}
              className="mt-3 text-[11px] uppercase tracking-[0.16em] hover:underline"
              style={{ color: "var(--muted)" }}
            >
              Remove stored key
            </button>
          ) : null}
        </div>
      ) : null}

      {!needsKey ? (
        <>
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="What is the compensation philosophy? How is the LTI plan designed?"
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  ask(question);
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.slice(0, 3).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => ask(p)}
                    className="rounded-full border px-3 py-1 text-[11px] hover:border-accent"
                    style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={question.trim().length < 2 || history.some((q) => q.loading)}
                className="btn btn-primary md:w-32"
              >
                {history.some((q) => q.loading) ? "Thinking…" : "Ask"}
              </button>
            </div>
          </form>

          <details className="mt-3">
            <summary
              className="cursor-pointer text-[11px] uppercase tracking-[0.16em]"
              style={{ color: "var(--muted)" }}
            >
              More suggested questions
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.slice(3).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => ask(p)}
                  className="rounded-full border px-3 py-1 text-[11px] hover:border-accent"
                  style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                >
                  {p}
                </button>
              ))}
            </div>
          </details>
        </>
      ) : null}

      {history.length > 0 ? (
        <div className="mt-6 flex flex-col gap-4">
          {history
            .slice()
            .reverse()
            .map((q) => (
              <article
                key={q.id}
                className="rounded-md border p-4"
                style={{ borderColor: "var(--line)", background: "var(--surface-alt)" }}
              >
                <p
                  className="text-[11px] uppercase tracking-[0.16em]"
                  style={{ color: "var(--accent)" }}
                >
                  Question
                </p>
                <p className="mt-1 text-sm" style={{ color: "var(--text)" }}>
                  {q.question}
                </p>

                {q.loading ? (
                  <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
                    Thinking through the filing…
                  </p>
                ) : null}

                {q.error ? (
                  <p className="mt-3 text-sm" style={{ color: "var(--text)" }}>
                    Couldn&rsquo;t reach the model: {q.error}
                  </p>
                ) : null}

                {q.answer ? <AnswerView answer={q.answer} /> : null}
              </article>
            ))}
          <button
            type="button"
            onClick={clearHistory}
            className="self-start text-[11px] uppercase tracking-[0.16em] hover:underline"
            style={{ color: "var(--muted)" }}
          >
            Clear history
          </button>
        </div>
      ) : null}
    </section>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  const scope = scopeNoteCopy(answer.scope_note);
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>
          {answer.title}
        </h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${
            scope.tone === "stop"
              ? "border-red-400 text-red-400"
              : scope.tone === "warn"
                ? "border-amber-400 text-amber-400"
                : ""
          }`}
          style={
            scope.tone === "ok" ? { borderColor: "var(--line)", color: "var(--muted)" } : undefined
          }
        >
          {scope.label}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text)" }}>
        {answer.summary}
      </p>
      {answer.bullets.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {answer.bullets.map((b, i) => (
            <li
              key={i}
              className="text-sm leading-relaxed"
              style={{ color: "var(--text)" }}
            >
              · {b}
            </li>
          ))}
        </ul>
      ) : null}
      {answer.scope_explanation ? (
        <p
          className="mt-3 text-xs italic leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          {answer.scope_explanation}
        </p>
      ) : null}
      {answer.citations.length > 0 ? (
        <div className="mt-4">
          <p
            className="text-[11px] uppercase tracking-[0.16em]"
            style={{ color: "var(--accent)" }}
          >
            Citations
          </p>
          <ul className="mt-1 space-y-1.5">
            {answer.citations.map((c, i) => (
              <li
                key={i}
                className="rounded border px-2.5 py-1.5 text-[12px] leading-relaxed"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }}
              >
                <strong style={{ color: "var(--text)" }}>{citationLabel(c)}</strong>
                <p
                  className="mt-1 text-[11px] italic leading-relaxed"
                  style={{ color: "var(--muted)" }}
                >
                  &ldquo;{c.excerpt}&rdquo;
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
