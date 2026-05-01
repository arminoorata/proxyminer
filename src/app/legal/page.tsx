import Link from "next/link";

export const metadata = {
  title: "Legal & source notice",
  description: "Where ProxyMiner data comes from and what it isn't.",
};

export default function LegalPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-14 md:px-10">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        ProxyMiner / Legal
      </p>
      <h1 className="mt-4 text-3xl font-semibold md:text-4xl">
        Legal &amp; source notice
      </h1>
      <p
        className="mt-4 max-w-2xl text-base leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        ProxyMiner is a research support tool. It is not a substitute for
        reading the filings themselves.
      </p>

      <Section title="Where the data comes from">
        Everything you see here is derived from public SEC{" "}
        <code>DEF 14A</code> proxy filings, retrieved directly from EDGAR.
        Each artifact (the pay table, the peer group, the policy facts) is
        accompanied by a source excerpt and a link back to the original
        filing.
      </Section>

      <Section title="What can go wrong">
        ProxyMiner&apos;s extraction is rule-based. It can be wrong:
        executive titles can split across rows, peer groups can be
        described in unusual prose, policies can use language we don&apos;t
        recognize. When in doubt, the original filing is the truth.
      </Section>

      <Section title="What it isn't">
        ProxyMiner is not investment advice, not legal advice, and not a
        compensation consulting service. It does not replace
        compensation-committee deliberation or counsel review.
      </Section>

      <Section title="Corrections & defensibility">
        If you spot an extraction issue, please open an issue against the
        public repo or email Armi at{" "}
        <a
          href="mailto:armi.noorata@gmail.com"
          className="underline"
          style={{ color: "var(--accent)" }}
        >
          armi.noorata@gmail.com
        </a>
        . An internal review console at <code>/review</code> exists for
        triage. Reviewer notes and verification status are stored alongside
        every extracted artifact.
      </Section>

      <Section title="Affiliations">
        ProxyMiner is built and maintained by{" "}
        <Link
          href="https://arminoorata.com"
          className="underline"
          style={{ color: "var(--accent)" }}
        >
          Armi Noorata
        </Link>
        . It is not affiliated with the SEC, with any compensation
        consulting firm, or with any of the issuers whose filings are
        indexed.
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium" style={{ color: "var(--text)" }}>
        {title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
        {children}
      </p>
    </section>
  );
}
