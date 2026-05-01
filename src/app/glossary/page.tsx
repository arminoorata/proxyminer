import Link from "next/link";

import { GLOSSARY } from "@/lib/glossary";

export const metadata = {
  title: "Glossary",
  description:
    "Plain-English definitions for the executive compensation terms ProxyMiner surfaces.",
};

export default function GlossaryPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-14 md:px-10">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        ProxyMiner / Glossary
      </p>
      <h1 className="mt-4 text-3xl font-semibold md:text-4xl">
        Plain-English definitions
      </h1>
      <p
        className="mt-4 max-w-2xl text-base leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        Compensation jargon, decoded. If something here is wrong or missing,
        the filing itself is always the truth — open the SEC link on the
        company page.
      </p>

      <dl className="mt-10 grid grid-cols-1 gap-6">
        {GLOSSARY.map((entry) => (
          <div
            key={entry.term}
            id={entry.term.toLowerCase().replace(/\s+/g, "-")}
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            <dt className="text-base font-medium">{entry.term}</dt>
            {entry.aliases.length > 0 ? (
              <p
                className="mt-1 text-xs"
                style={{ color: "var(--muted)" }}
              >
                Also: {entry.aliases.join(", ")}
              </p>
            ) : null}
            <dd
              className="mt-3 text-sm leading-relaxed"
              style={{ color: "var(--text)" }}
            >
              {entry.definition}
            </dd>
          </div>
        ))}
      </dl>

      <p
        className="mt-12 text-sm"
        style={{ color: "var(--muted)" }}
      >
        Need the source? <Link href="/legal" className="underline">Legal &amp; source notice</Link>.
      </p>
    </main>
  );
}
