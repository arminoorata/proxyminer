import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer
      className="mt-24 border-t"
      style={{ borderColor: "var(--line)" }}
    >
      <div
        className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-10 text-sm md:px-10"
        style={{ color: "var(--muted)" }}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
          <div>
            <p>
              Built by{" "}
              <Link
                href="https://arminoorata.com"
                className="underline underline-offset-4"
                style={{ color: "var(--text)" }}
              >
                Armi Noorata
              </Link>
              .
            </p>
            <p className="mt-1.5 text-xs">
              Source-grounded research support &mdash; not investment, legal, or
              compensation advice.{" "}
              <Link
                href="/legal"
                className="underline underline-offset-4"
                style={{ color: "var(--text)" }}
              >
                Legal &amp; source notice
              </Link>
              .
            </p>
            <nav className="mt-2 flex flex-wrap items-center gap-2 text-xs" aria-label="Tool sections">
              <Link href="/guide" className="hover:text-accent">Guide</Link>
              <span aria-hidden>·</span>
              <Link href="/glossary" className="hover:text-accent">Glossary</Link>
              <span aria-hidden>·</span>
              <Link href="/legal" className="hover:text-accent">Legal</Link>
            </nav>
          </div>
          <p className="text-xs uppercase tracking-[0.24em]">
            proxyminer.arminoorata.com
          </p>
        </div>
        <p
          className="border-t pt-4 text-[11.5px] italic leading-relaxed opacity-85"
          style={{ borderColor: "var(--line)", maxWidth: "80ch" }}
        >
          ProxyMiner extracts and normalizes data from public SEC proxy
          filings. Extraction and normalization may contain errors. Always
          verify against the original filing before acting on what you see
          here. ProxyMiner is not affiliated with the SEC.
        </p>
      </div>
    </footer>
  );
}
