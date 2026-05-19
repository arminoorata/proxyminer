/**
 * Public on-demand import page.
 *
 *   /import/AAPL  →  triggers POST /api/ingest/public/aapl, watches the
 *                    result, redirects to /company/aapl when done.
 *
 * If the ticker is already in the database (and the row has at least
 * one filing), we short-circuit straight to the company page without
 * re-running the ingest pipeline. This matches requirement #2 (search
 * first, then ingest) at the route level.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import ImportRunner from "@/components/ImportRunner";
import { getCompany, listFilings } from "@/lib/data/source";
import { isValidTickerShape } from "@/lib/services/ticker-validation";

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ticker } = await params;
  const raw = (ticker ?? "").trim();
  const sp = await searchParams;
  const jobIdParam = typeof sp.jobId === "string" ? sp.jobId : "";
  const initialJobId = (() => {
    const n = Number.parseInt(jobIdParam, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  if (!isValidTickerShape(raw)) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 md:px-10 md:py-24">
        <p
          className="text-xs font-medium uppercase tracking-[0.32em]"
          style={{ color: "var(--accent)" }}
        >
          Import error
        </p>
        <h1 className="mt-4 text-3xl font-semibold leading-tight">
          That ticker doesn&rsquo;t look right.
        </h1>
        <p
          className="mt-4 text-sm leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Tickers must start with a letter and be 1&ndash;8 characters
          (letters, digits, &ldquo;.&rdquo; or &ldquo;-&rdquo;). Try the
          home page search instead.
        </p>
        <Link href="/" className="btn btn-primary mt-6 inline-block">
          Back to search
        </Link>
      </main>
    );
  }

  // Fast-path: already in the DB with at least one filing — skip the
  // import entirely and route to the existing company page. We skip
  // this short-circuit when ?jobId= is present in the URL: that
  // signals the user is mid-import and reloaded the page, and they
  // expect to keep watching the job (not silently jump to a possibly
  // stale company page).
  const lower = raw.toLowerCase();
  if (initialJobId == null) {
    const existing = await getCompany(lower);
    if (existing) {
      const filings = await listFilings(existing.id);
      if (filings.length > 0) {
        redirect(`/company/${existing.id}`);
      }
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 md:px-10 md:py-24">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        Importing from SEC EDGAR
      </p>
      <h1 className="mt-4 text-3xl font-semibold leading-tight md:text-4xl">
        {raw.toUpperCase()}
      </h1>
      <p
        className="mt-4 text-sm leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        Fetching the latest two DEF 14A proxy filings and running the
        full extractor pipeline. This takes 10&ndash;45 seconds. Leave
        this tab open.
      </p>
      <ImportRunner ticker={raw} initialJobId={initialJobId} />
    </main>
  );
}
