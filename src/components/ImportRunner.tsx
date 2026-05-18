"use client";

/**
 * Client-side driver for /import/[ticker]. POSTs once to
 * /api/ingest/public/[ticker] with a 90s abort budget (route maxDuration
 * is 60s but we add headroom for network), then routes the user to
 * /company/[id] on success or surfaces a typed error message on failure.
 *
 * Progress: the underlying endpoint is synchronous, so we don't have
 * intermediate phase signals. A staged label cycle keeps the user
 * oriented while they wait.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface ImportResponse {
  ok?: boolean;
  status?: "ingested" | "already_ingested" | "in_flight";
  company_id?: string | null;
  filings_processed?: number;
  errors?: string[];
  error?: string;
  message?: string;
}

const PHASES = [
  "Resolving ticker on SEC EDGAR…",
  "Fetching DEF 14A filings…",
  "Extracting CD&A, peer panels, pay ratio, committee report…",
  "Saving structured data…",
];

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
  rate_gate_failed:
    "We couldn't check the rate limit. Try again in a minute.",
  ingest_failed:
    "The import resolved the ticker but failed during extraction. Report this if it persists.",
  db_unavailable:
    "Database is unreachable right now. Try again shortly.",
};

export default function ImportRunner({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const fired = useRef(false);

  useEffect(() => {
    // Strict-mode guards: ensure we only fire the POST once per mount.
    if (fired.current) return;
    fired.current = true;

    const abort = new AbortController();
    const phaseTimer = setInterval(() => {
      setPhase((p) => Math.min(p + 1, PHASES.length - 1));
    }, 4_000);
    const hardTimeout = setTimeout(() => abort.abort(), 90_000);

    (async () => {
      try {
        const res = await fetch(
          `/api/ingest/public/${encodeURIComponent(ticker.toLowerCase())}`,
          { method: "POST", signal: abort.signal },
        );
        const data = (await res.json().catch(() => ({}))) as ImportResponse;

        if (!res.ok) {
          const code = data.error ?? `http_${res.status}`;
          setError({
            code,
            message:
              data.message ?? ERROR_HINTS[code] ?? `Import failed (${code}).`,
          });
          return;
        }

        if (data.ok && data.company_id) {
          setDone(true);
          // Tiny delay so the user reads "Done" before the redirect.
          setTimeout(() => {
            router.push(`/company/${data.company_id}`);
          }, 1200);
          return;
        }

        // Server returned ok:false with no company_id (no_proxy_found etc.)
        const code = data.error ?? "ingest_failed";
        setError({
          code,
          message:
            data.message ?? ERROR_HINTS[code] ?? "Import failed unexpectedly.",
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setError({
            code: "timeout",
            message:
              "The import took longer than 90 seconds. SEC may be slow right now — try again shortly.",
          });
          return;
        }
        setError({
          code: "network_error",
          message:
            err instanceof Error
              ? err.message
              : "Network error while contacting the server.",
        });
      } finally {
        clearInterval(phaseTimer);
        clearTimeout(hardTimeout);
      }
    })();

    return () => {
      clearInterval(phaseTimer);
      clearTimeout(hardTimeout);
      abort.abort();
    };
  }, [ticker, router]);

  if (error) {
    return (
      <div
        className="mt-8 rounded-lg border p-5"
        style={{
          borderColor: "var(--line)",
          background: "var(--surface)",
        }}
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
                fired.current = false;
                setError(null);
                setPhase(0);
                router.refresh();
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-8 rounded-lg border p-5"
      style={{
        borderColor: "var(--line)",
        background: "var(--surface)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-pulse rounded-full"
          style={{ background: done ? "var(--accent)" : "var(--accent)" }}
        />
        <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
          {done ? "Done — redirecting…" : PHASES[phase]}
        </p>
      </div>
      <ol className="mt-5 space-y-2 text-sm" style={{ color: "var(--muted)" }}>
        {PHASES.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background:
                  i < phase || done
                    ? "var(--accent)"
                    : i === phase
                      ? "color-mix(in srgb, var(--accent) 50%, transparent)"
                      : "var(--line)",
              }}
            />
            <span style={{ color: i <= phase || done ? "var(--text)" : "var(--muted)" }}>
              {label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
