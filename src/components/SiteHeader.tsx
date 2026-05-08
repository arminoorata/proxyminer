import Link from "next/link";

import NavMenu from "./NavMenu";
import ThemeToggle from "./ThemeToggle";

/**
 * Top-of-page bar. Eyebrow brand on the left, NavMenu + ThemeToggle on the
 * right. Layout matches every sibling tool (fair., signs., flsa., etc.) so
 * proxyminer.arminoorata.com reads as one family with the rest.
 */
export default function SiteHeader() {
  return (
    <header
      className="sticky top-0 z-30 border-b backdrop-blur"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in srgb, var(--bg) 88%, transparent)",
      }}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4 md:px-10">
        <div className="flex items-baseline gap-6">
          <Link href="/" className="block" aria-label="ProxyMiner home">
            <p
              className="text-xs font-medium uppercase tracking-[0.32em]"
              style={{ color: "var(--accent)" }}
            >
              ProxyMiner Toolkit
            </p>
          </Link>
          <nav className="hidden items-center gap-4 text-[11px] uppercase tracking-[0.16em] md:flex">
            <Link href="/" className="hover:underline" style={{ color: "var(--muted)" }}>
              Companies
            </Link>
            <Link href="/compare" className="hover:underline" style={{ color: "var(--muted)" }}>
              Compare
            </Link>
            <Link href="/guide" className="hover:underline" style={{ color: "var(--muted)" }}>
              Guide
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <NavMenu />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
