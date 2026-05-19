"use client";

/**
 * Client driver for /import/[ticker] with the durable job model.
 *
 * Flow:
 *   1. On mount, if `?job=<24-hex>` is already in the URL, attach to
 *      that job and start polling. Otherwise POST
 *      /api/ingest/public/[ticker] once, persist the returned
 *      `job_token` into the URL (so refresh keeps its place), then
 *      start polling.
 *   2. Poll /api/ingest/status/<token> every 2 seconds.
 *   3. On terminal status (`ok` / `partial`) redirect to /company/[id].
 *   4. On `failed`, show typed error message + retry/back.
 *
 * Tokens are app-generated 24-char hex (96 bits of entropy) so the
 * URL is non-enumerable.
 *
 * Strict-mode-safe: the POST is guarded by a ref so React's double-mount
 * doesn't fire two requests. The status row is the source of truth — the
 * UI only displays what the server says.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Status =
  | "queued"
  | "resolving"
  | "fetching"
  | "extracting"
  | "saving"
  | "ok"
  | "partial"
  | "failed";

interface StatusResponse {
  job_token: string;
  status: Status;
  phase_label: string;
  identifier: string;
  company_id: string | null;
  filings_processed: number | null;
  filings_total: number | null;
  terminal: boolean;
  error_code: string | null;
  error_message: string | null;
}

interface PostResponse {
  ok?: boolean;
  status?: "queued" | "running" | "already_ingested";
  job_token?: string | null;
  company_id?: string | null;
  error?: string;
  message?: string;
}

const TERMINAL: ReadonlySet<Status> = new Set(["ok", "partial", "failed"]);

const ORDER: Status[] = [
  "queued",
  "resolving",
  "fetching",
  "extracting",
  "saving",
];

const PHASE_LABELS: Record<Status, string> = {
  queued: "Queued",
  resolving: "Resolving ticker on SEC EDGAR…",
  fetching: "Fetching DEF 14A filings…",
  extracting: "Extracting CD&A, peer panels, pay ratio, committee report…",
  saving: "Saving structured data…",
  ok: "Done — redirecting…",
  partial: "Done with warnings — redirecting…",
  failed: "Failed",
};

const ERROR_HINTS: Record<string, string> = {
  invalid_ticker:
    "That ticker isn't shaped like a SEC ticker. Tickers are 1–8 letters/digits.",
  not_in_sec_tickers:
    "SEC EDGAR doesn't list a company with this ticker. Check the spelling.",
  no_proxy_found:
    "SEC has no DEF 14A proxy filings on file for this company. ProxyMiner only covers proxies.",
  client_cap:
    "You've imported 5 companies in the last hour. Wait a bit and try again.",
  sec_fetch_failed:
    "SEC EDGAR didn't return a clean response. This is usually transient — try again in a minute.",
  ingest_failed:
    "Extraction failed unexpectedly. Report this if it persists.",
  partial_failure:
    "Some filings imported, others failed. Open the company page to see what landed.",
};

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_WAIT_MS = 5 * 60 * 1000;

export default function ImportRunner({
  ticker,
  initialJobToken,
}: {
  ticker: string;
  initialJobToken: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [jobToken, setJobToken] = useState<string | null>(initialJobToken);
  const [snap, setSnap] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const submitted = useRef(false);
  const redirected = useRef(false);

  const setJobTokenInUrl = useCallback(
    (token: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.set("job", token);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const submit = useCallback(async (): Promise<string | null> => {
    const res = await fetch(
      `/api/ingest/public/${encodeURIComponent(ticker.toLowerCase())}`,
      { method: "POST" },
    );
    const data = (await res.json().catch(() => ({}))) as PostResponse;

    if (!res.ok) {
      const code = data.error ?? `http_${res.status}`;
      setError({
        code,
        message: data.message ?? ERROR_HINTS[code] ?? `Import failed (${code}).`,
      });
      return null;
    }
    if (data.status === "already_ingested" && data.company_id) {
      // Already imported recently — jump straight to the company page.
      redirected.current = true;
      router.push(`/company/${data.company_id}`);
      return null;
    }
    if (data.job_token) {
      setJobTokenInUrl(data.job_token);
      return data.job_token;
    }
    setError({
      code: data.error ?? "ingest_failed",
      message:
        data.message ??
        ERROR_HINTS[data.error ?? "ingest_failed"] ??
        "Import failed unexpectedly.",
    });
    return null;
  }, [router, ticker, setJobTokenInUrl]);

  const pollOnce = useCallback(
    async (token: string, signal: AbortSignal): Promise<StatusResponse | null> => {
      const res = await fetch(`/api/ingest/status/${token}`, { signal });
      if (!res.ok) {
        if (res.status === 404) {
          setError({
            code: "job_lost",
            message: "Job not found. It may have been cleared — try again.",
          });
        } else if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          if (body.error === "migration_pending") {
            setError({
              code: "migration_pending",
              message:
                body.message ??
                "Server schema is awaiting an update. Try again in a minute.",
            });
          }
        }
        return null;
      }
      return (await res.json()) as StatusResponse;
    },
    [],
  );

  useEffect(() => {
    if (redirected.current) return;
    const abort = new AbortController();
    const startedAt = Date.now();

    (async () => {
      let activeToken = jobToken;

      // First submission (only if no token in URL yet).
      if (activeToken == null && !submitted.current) {
        submitted.current = true;
        activeToken = await submit();
        if (activeToken == null) return;
        setJobToken(activeToken);
      }
      if (activeToken == null) return;

      // Poll loop. Bounded by POLL_MAX_WAIT_MS so a wedged worker can't
      // hold the UI forever; user can still refresh and resume.
      while (!abort.signal.aborted) {
        if (Date.now() - startedAt > POLL_MAX_WAIT_MS) {
          setError({
            code: "timeout",
            message:
              "Import is taking longer than 5 minutes. Refresh this page to resume polling, or try again.",
          });
          return;
        }
        const snap = await pollOnce(activeToken, abort.signal);
        if (abort.signal.aborted) return;
        if (snap) {
          setSnap(snap);
          if (snap.terminal) {
            if (
              (snap.status === "ok" || snap.status === "partial") &&
              snap.company_id
            ) {
              redirected.current = true;
              setTimeout(() => {
                router.push(`/company/${snap.company_id}`);
              }, 900);
              return;
            }
            const code = snap.error_code ?? "ingest_failed";
            setError({
              code,
              message:
                snap.error_message ?? ERROR_HINTS[code] ?? "Import failed.",
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    })();

    return () => {
      abort.abort();
    };
    // jobToken is intentionally a dep — when the first POST returns we
    // restart the effect with the resolved token.
  }, [jobToken, submit, pollOnce, router]);

  if (error) {
    return (
      <div
        className="mt-8 rounded-lg border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <p
          className="text-[11px] font-medium uppercase tracking-[0.18em]"
          style={{ color: "var(--accent)" }}
        >
          Import failed
        </p>
        <p className="mt-2 text-base font-semibold" style={{ color: "var(--text)" }}>
          {error.message}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Error code: <code>{error.code}</code>
        </p>
        <div className="mt-5 flex gap-3">
          <Link href="/" className="btn btn-primary">
            Back to search
          </Link>
          {error.code !== "invalid_ticker" && error.code !== "not_in_sec_tickers" ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                submitted.current = false;
                redirected.current = false;
                setJobToken(null);
                setSnap(null);
                setError(null);
                const next = new URLSearchParams(
                  searchParams?.toString() ?? "",
                );
                next.delete("job");
                router.replace(`?${next.toString()}`, { scroll: false });
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const currentStatus: Status = snap?.status ?? "queued";
  const currentPhaseIdx = Math.max(0, ORDER.indexOf(currentStatus));
  const phaseLabel = snap?.phase_label ?? PHASE_LABELS[currentStatus];
  const filingsDone = snap?.filings_processed ?? null;
  const filingsTotal = snap?.filings_total ?? null;

  return (
    <div
      className="mt-8 rounded-lg border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-pulse rounded-full"
          style={{ background: "var(--accent)" }}
        />
        <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
          {phaseLabel}
        </p>
      </div>
      <ol className="mt-5 space-y-2 text-sm" style={{ color: "var(--muted)" }}>
        {ORDER.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background:
                  i < currentPhaseIdx || TERMINAL.has(currentStatus)
                    ? "var(--accent)"
                    : i === currentPhaseIdx
                      ? "color-mix(in srgb, var(--accent) 50%, transparent)"
                      : "var(--line)",
              }}
            />
            <span
              style={{
                color:
                  i <= currentPhaseIdx || TERMINAL.has(currentStatus)
                    ? "var(--text)"
                    : "var(--muted)",
              }}
            >
              {PHASE_LABELS[label]}
            </span>
          </li>
        ))}
      </ol>
      {filingsDone != null && filingsTotal != null && filingsTotal > 0 ? (
        <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
          Filings: {filingsDone}/{filingsTotal}
        </p>
      ) : null}
      {jobToken ? (
        <p className="mt-4 text-[11px] uppercase tracking-[0.18em]" style={{ color: "var(--muted)" }}>
          Job {jobToken.slice(0, 8)}…
        </p>
      ) : null}
    </div>
  );
}
