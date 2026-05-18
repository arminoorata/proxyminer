import Link from "next/link";
import { redirect } from "next/navigation";

import { listCompanies } from "@/lib/data/source";
import { isValidTickerShape } from "@/lib/services/ticker-validation";

const QUICK_PICKS = ["aapl", "msft", "adbe", "meta", "amzn", "googl"];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested =
    typeof params.company === "string" ? params.company.trim() : "";

  const companies = await listCompanies();

  // Server-side resolve: ticker exact, then ID exact, then case-insensitive
  // name contains. This is the same precedence the Python `resolveCompanyMatch`
  // uses today, ported into the new Vercel app so behavior doesn't shift.
  if (requested) {
    const lower = requested.toLowerCase();
    const match =
      companies.find((c) => (c.ticker ?? "").toLowerCase() === lower) ??
      companies.find((c) => c.id.toLowerCase() === lower) ??
      companies.find((c) => c.name.toLowerCase().includes(lower));
    if (match) {
      redirect(`/company/${match.id}`);
    }
    redirect(`/?miss=1&search=${encodeURIComponent(requested)}`);
  }

  const showMiss = params.miss === "1";
  const search =
    typeof params.search === "string" ? params.search : "";

  const offerImport = showMiss && isValidTickerShape(search);
  const importTicker = offerImport ? search.trim().toUpperCase() : "";

  const quickPicks = QUICK_PICKS.map((id) =>
    companies.find((c) => c.id === id),
  ).filter((c): c is (typeof companies)[number] => Boolean(c));

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 md:px-10 md:py-24">
      <header className="mb-10">
        <p
          className="text-xs font-medium uppercase tracking-[0.32em]"
          style={{ color: "var(--accent)" }}
        >
          ProxyMiner
        </p>
        <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-5xl">
          What did they pay them?
        </h1>
        <p
          className="mt-5 max-w-xl text-base leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Executive pay, peer benchmarks, and governance signals pulled
          straight from public SEC proxy filings. Pick a company to begin.
        </p>
      </header>

      {showMiss ? (
        <div
          className="mb-6 rounded-lg border px-4 py-4 text-sm"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface-alt)",
            color: "var(--muted)",
          }}
        >
          <p>
            No match for &ldquo;{search}&rdquo; in ProxyMiner&rsquo;s
            database.
          </p>
          {offerImport ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span style={{ color: "var(--text)" }}>
                Want to pull <strong>{importTicker}</strong> straight
                from SEC EDGAR?
              </span>
              <Link
                href={`/import/${encodeURIComponent(importTicker.toLowerCase())}`}
                className="btn btn-primary self-start sm:self-auto"
              >
                Import {importTicker} from SEC →
              </Link>
            </div>
          ) : (
            <p className="mt-2" style={{ color: "var(--muted)" }}>
              Try a ticker (e.g. AAPL), or pick one of the popular
              companies below.
            </p>
          )}
        </div>
      ) : null}

      <form
        action="/"
        method="get"
        className="flex flex-col gap-3 rounded-lg border p-5 md:flex-row md:items-end"
        style={{
          borderColor: "var(--line)",
          background: "var(--surface)",
        }}
      >
        <label className="flex flex-1 flex-col gap-1.5 text-sm">
          <span
            className="text-[11px] font-medium uppercase tracking-[0.18em]"
            style={{ color: "var(--accent)" }}
          >
            Company
          </span>
          <input
            list="proxyminer-company-options"
            name="company"
            placeholder="Apple, AAPL, Microsoft, MSFT"
            autoComplete="off"
            defaultValue={search}
            className="rounded-md border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
          />
          <datalist id="proxyminer-company-options">
            {companies.map((c) => (
              <option
                key={c.id}
                value={c.ticker ?? c.name}
                label={`${(c.ticker ?? c.id).toUpperCase()} — ${c.name}`}
              />
            ))}
          </datalist>
        </label>
        <button type="submit" className="btn btn-primary md:w-40">
          Open company
        </button>
      </form>

      <section className="mt-8">
        <p
          className="text-[11px] font-medium uppercase tracking-[0.18em]"
          style={{ color: "var(--accent)" }}
        >
          Popular
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {quickPicks.map((c) => (
            <Link
              key={c.id}
              href={`/company/${c.id}`}
              className="rounded-full border px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
            >
              {(c.ticker ?? c.id).toUpperCase()}
            </Link>
          ))}
        </div>
      </section>

      <p
        className="mt-12 max-w-2xl text-sm leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        Everything here comes from the filings themselves. Extraction can be
        wrong; the filing is the truth. When in doubt, open the SEC link on
        the company page.
      </p>
    </main>
  );
}
