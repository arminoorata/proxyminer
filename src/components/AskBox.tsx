"use client";

/**
 * BYOK Ask interface for the company workspace. The user pastes their
 * Google AI Studio key; we keep it in sessionStorage by default
 * (cleared on tab close) with an explicit "remember on this device"
 * opt-in for localStorage. The key is sent to /api/ask via the
 * X-Gemini-Api-Key header, never in the body — the server uses it
 * once for the Gemini call and never persists it.
 *
 * Answers come back with citations bound to artifacts in the loaded
 * context; the route already drops citations that don't resolve.
 * Mirrors equity.arminoorata.com's Ask pattern: free for everyone,
 * citations first-class.
 */
import { useEffect, useState } from "react";

import { citationLabel, scopeNoteCopy } from "@/lib/ai/answer-display";
import { isAnswer, type Answer } from "@/lib/ai/answer-schema";

interface QA {
  id: string;
  question: string;
  answer: Answer | null;
  error: string | null;
  loading: boolean;
}

const KEY_STORAGE = "proxyminer_gemini_key";
const REMEMBER_FLAG = "proxyminer_remember_key";
const HISTORY_STORAGE_PREFIX = "proxyminer_ask_history_";
const MAX_HISTORY = 20;
const MAX_EXCERPT_DISPLAY = 280;
const MAX_LABEL_DISPLAY = 120;

// Strip non-printable / bidi control characters so a malicious citation
// excerpt can't override layout direction or render hidden glyphs.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
function safeText(s: string, max: number): string {
  return s.replace(CONTROL_CHAR_RE, "").trim().slice(0, max);
}

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

export default function AskBox({ companyId, companyName, filingId, filingYear }: AskBoxProps) {
  const [apiKey, setApiKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [showKeyEdit, setShowKeyEdit] = useState(false);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load key (sessionStorage default; localStorage only if user
  // previously opted into "remember"). Load history, dropping any
  // mid-flight loading entries (a tab reload between question and
  // answer would otherwise leave a permanent "Thinking…" item).
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const remembered = window.localStorage.getItem(REMEMBER_FLAG) === "1";
        const k =
          (remembered ? window.localStorage.getItem(KEY_STORAGE) : null) ??
          window.sessionStorage.getItem(KEY_STORAGE) ??
          "";
        setRememberKey(remembered);
        setApiKey(k);
        const h = window.sessionStorage.getItem(HISTORY_STORAGE_PREFIX + companyId);
        if (h) {
          const parsed = JSON.parse(h) as QA[];
          const cleaned = parsed.map((q) =>
            q.loading
              ? { ...q, loading: false, error: "Request was interrupted by a page reload." }
              : q,
          );
          setHistory(cleaned);
        }
      } catch {
        /* storage may be disabled — degrade silently */
      }
      setLoaded(true);
    });
  }, [companyId]);

  // Persist only completed Q&A to sessionStorage so a reload doesn't
  // resurrect a stuck "Thinking…" placeholder.
  useEffect(() => {
    if (!loaded) return;
    try {
      const persisted = history
        .filter((q) => !q.loading)
        .slice(-MAX_HISTORY);
      window.sessionStorage.setItem(
        HISTORY_STORAGE_PREFIX + companyId,
        JSON.stringify(persisted),
      );
    } catch {
      /* ignore */
    }
  }, [history, companyId, loaded]);

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (trimmed.length < 20) return;
    try {
      // Always write sessionStorage; mirror to localStorage only when
      // the user opted in. Clear the inverse storage so the key can't
      // linger after a preference change.
      window.sessionStorage.setItem(KEY_STORAGE, trimmed);
      if (rememberKey) {
        window.localStorage.setItem(KEY_STORAGE, trimmed);
        window.localStorage.setItem(REMEMBER_FLAG, "1");
      } else {
        window.localStorage.removeItem(KEY_STORAGE);
        window.localStorage.removeItem(REMEMBER_FLAG);
      }
    } catch {
      /* ignore */
    }
    setApiKey(trimmed);
    setKeyDraft("");
    setShowKeyEdit(false);
  }

  function clearKey() {
    try {
      window.sessionStorage.removeItem(KEY_STORAGE);
      window.localStorage.removeItem(KEY_STORAGE);
      window.localStorage.removeItem(REMEMBER_FLAG);
    } catch {
      /* ignore */
    }
    setApiKey("");
    setRememberKey(false);
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
        headers: {
          "content-type": "application/json",
          "x-gemini-api-key": apiKey,
        },
        body: JSON.stringify({
          question: text,
          company_id: companyId,
          filing_id: filingId,
        }),
      });
      const data = (await res.json()) as unknown;
      setHistory((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          if (data && typeof data === "object" && "error" in data) {
            const err = (data as { error?: unknown }).error;
            return {
              ...q,
              loading: false,
              error: typeof err === "string" ? err : "Request failed.",
            };
          }
          if (isAnswer(data)) {
            return { ...q, loading: false, answer: data, error: null };
          }
          return {
            ...q,
            loading: false,
            error: "Got an unexpected response shape from the server.",
          };
        }),
      );
    } catch {
      // Don't echo network error details — they're noisy and may leak
      // internal information. Show a stable message.
      setHistory((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                loading: false,
                error: "Couldn't reach the server. Check your connection and retry.",
              }
            : q,
        ),
      );
    }
  }

  function clearHistory() {
    setHistory([]);
    try {
      window.sessionStorage.removeItem(HISTORY_STORAGE_PREFIX + companyId);
    } catch {
      /* ignore */
    }
  }

  // Don't gate the entire section on client mount — render a
  // deterministic shell during SSR so the page doesn't reflow when
  // the component hydrates. Only the dynamic bits (stored key, Q&A
  // history) wait for the effect.
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

      {!loaded ? (
        <div
          className="mt-5 rounded-md border p-4"
          style={{ borderColor: "var(--line)", background: "var(--surface-alt)" }}
          aria-busy="true"
        >
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Loading the Ask interface…
          </p>
        </div>
      ) : null}

      {loaded && needsKey ? (
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
            . By default, your key stays only in this tab&rsquo;s sessionStorage and is wiped when
            the tab closes. ProxyMiner forwards it to Google in a per-request header and never
            writes it to the database.
          </p>
          <div className="mt-3 flex flex-col gap-2 md:flex-row">
            <label className="sr-only" htmlFor="proxyminer-gemini-key">
              Google AI Studio API key
            </label>
            <input
              id="proxyminer-gemini-key"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="AIza…"
              aria-label="Google AI Studio API key"
              className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
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
          <label
            className="mt-3 flex items-center gap-2 text-[11px]"
            style={{ color: "var(--muted)" }}
          >
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={(e) => setRememberKey(e.target.checked)}
              className="h-3 w-3"
            />
            Remember on this device (stores in localStorage — readable by browser extensions on
            this origin).
          </label>
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

      {loaded && !needsKey ? (
        <>
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <label className="sr-only" htmlFor="proxyminer-ask-question">
              Question about {companyName}&rsquo;s {filingYear} proxy
            </label>
            <textarea
              id="proxyminer-ask-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="What is the compensation philosophy? How is the LTI plan designed?"
              aria-label={`Question about ${companyName}'s ${filingYear} proxy`}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
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
                  <p
                    className="mt-3 text-sm"
                    role="status"
                    aria-live="polite"
                    style={{ color: "var(--muted)" }}
                  >
                    Thinking through the filing…
                  </p>
                ) : null}

                {q.error ? (
                  <p
                    className="mt-3 text-sm"
                    role="alert"
                    style={{ color: "var(--text)" }}
                  >
                    {q.error}
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
                className="rounded border px-2.5 py-1.5 text-[12px] leading-relaxed break-words"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                dir="auto"
              >
                <strong style={{ color: "var(--text)" }}>
                  {safeText(citationLabel(c), MAX_LABEL_DISPLAY)}
                </strong>
                <p
                  className="mt-1 text-[11px] italic leading-relaxed break-words"
                  style={{ color: "var(--muted)" }}
                  dir="auto"
                >
                  &ldquo;{safeText(c.excerpt, MAX_EXCERPT_DISPLAY)}&rdquo;
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
