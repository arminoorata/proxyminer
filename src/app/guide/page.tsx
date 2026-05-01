import Link from "next/link";

export const metadata = {
  title: "Guide",
  description: "How to use ProxyMiner.",
};

export default function GuidePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-14 md:px-10">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        ProxyMiner / Guide
      </p>
      <h1 className="mt-4 text-3xl font-semibold md:text-4xl">
        How to use ProxyMiner
      </h1>
      <p
        className="mt-4 max-w-2xl text-base leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        Pick a company. Read the pay table. Then, only if you need the story
        behind the numbers, open the CD&amp;A narrative. That&apos;s the whole idea.
      </p>

      <ol className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Step n="1" title="Open a company">
          Ticker or name. Either works. You land directly on the company page,
          no dashboards in the way.
        </Step>
        <Step n="2" title="Read executive pay first">
          Pay mix and YoY delta sit right in the table. That&apos;s usually
          enough to know whether the committee story in the CD&amp;A is likely
          to hold up.
        </Step>
        <Step n="3" title="Skim the CD&A signals">
          Peer groups, governance policies, and performance markers are
          extracted alongside the pay table. Each carries the source excerpt
          and a SEC link.
        </Step>
        <Step n="4" title="Go deeper only if needed">
          Peer comparison when you want benchmarks. Source search when you
          need exact proxy language. If the answer isn&apos;t here, click
          through to the SEC filing — the filing is always the truth.
        </Step>
      </ol>

      <p className="mt-12 text-sm" style={{ color: "var(--muted)" }}>
        New term?{" "}
        <Link href="/glossary" className="underline">
          Glossary
        </Link>
        . Concerned about the data? <Link href="/legal" className="underline">Legal &amp; source notice</Link>.
      </p>
    </main>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className="rounded-lg border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <p
        className="text-[11px] font-medium uppercase tracking-[0.18em]"
        style={{ color: "var(--accent)" }}
      >
        Step {n}
      </p>
      <p className="mt-1.5 text-lg font-medium">{title}</p>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
        {children}
      </p>
    </li>
  );
}
