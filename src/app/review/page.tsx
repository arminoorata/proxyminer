/**
 * Internal review console. Strictly admin-token-gated. Shows the
 * extracted artifacts for a filing alongside their provenance + review
 * state, with mark-reviewed / flag / reset actions.
 *
 * Renders against fixtures in dev so the UI can be iterated without
 * Postgres. In prod it reads from the same DB the public surfaces use.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  REVIEW_COOKIE_NAME,
  validateReviewSession,
} from "@/lib/auth/review-session";
import { getFilingDetail, listCompanies, listFilings } from "@/lib/data/source";

export const metadata = { title: "Review console" };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Phase 31: previously this checked only cookie presence, leaving
  // the read surface unauthenticated as long as the client sent any
  // value at all. Validate the HMAC + expiry the same way the update
  // route does.
  const cookieStore = await cookies();
  const session = cookieStore.get(REVIEW_COOKIE_NAME);
  const auth = validateReviewSession(
    session?.value,
    process.env.PROXYMINER_REVIEW_COOKIE_SECRET,
  );
  if (!auth.ok) redirect("/review/login");

  const params = await searchParams;
  const filingId =
    typeof params.filing === "string" ? params.filing : "";

  const companies = await listCompanies();
  const filings = filingId
    ? null
    : (
        await Promise.all(
          companies.map(async (c) =>
            (await listFilings(c.id)).map((f) => ({ company: c, filing: f })),
          ),
        )
      ).flat();
  const detail = filingId ? await getFilingDetail(filingId) : null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 md:px-10">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        ProxyMiner / Review
      </p>
      <h1 className="mt-4 text-3xl font-semibold">Internal review console</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
        Internal QA only. Reviewer notes and verification status are persisted
        per artifact and surfaced on the public company page.
      </p>

      {!detail ? (
        <section className="mt-10">
          <h2 className="text-lg font-medium">All filings</h2>
          <ul
            className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2"
            style={{ color: "var(--muted)" }}
          >
            {filings?.map(({ company, filing }) => (
              <li
                key={filing.id}
                className="rounded-md border p-3"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <a
                  href={`/review?filing=${filing.id}`}
                  className="text-sm font-medium hover:underline"
                  style={{ color: "var(--text)" }}
                >
                  {company.ticker ?? company.id.toUpperCase()} · {filing.filing_year}
                </a>
                <p className="mt-1 text-xs">{filing.accession_number}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="mt-10 grid grid-cols-1 gap-6">
          <h2 className="text-lg font-medium">
            {detail.form_type} · {detail.filing_year} · {detail.id}
          </h2>
          <ArtifactBlock
            label="Sections"
            items={detail.sections.map((s) => ({
              id: String(s.id),
              type: "section",
              kind: s.section_type,
              value: (s.text ?? "").slice(0, 240) + (s.text && s.text.length > 240 ? "…" : ""),
              review_status: s.review_status,
              extractor_version: s.extractor_version,
            }))}
          />
          <ArtifactBlock
            label="Policy facts"
            items={detail.policies.map((p) => ({
              id: String(p.id),
              type: "policy_fact",
              kind: p.policy_type,
              value: p.normalized_value ?? p.summary ?? "",
              review_status: p.review_status,
              extractor_version: p.extractor_version,
            }))}
          />
          <ArtifactBlock
            label="Metric facts"
            items={detail.metrics.map((m) => ({
              id: String(m.id),
              type: "metric_fact",
              kind: m.metric_name_normalized ?? m.metric_name_raw,
              value: m.observed_value ?? "",
              review_status: m.review_status,
              extractor_version: m.extractor_version,
            }))}
          />
          <ArtifactBlock
            label="Peer groups"
            items={detail.peer_groups.map((g) => ({
              id: String(g.id),
              type: "peer_group",
              kind: g.peer_group_name ?? "compensation peers",
              value: `${g.members.length} members`,
              review_status: g.review_status,
              extractor_version: g.extractor_version,
            }))}
          />
        </section>
      )}
    </main>
  );
}

function ArtifactBlock({
  label,
  items,
}: {
  label: string;
  items: {
    id: string;
    type: string;
    kind: string;
    value: string;
    review_status: string;
    extractor_version: string | null;
  }[];
}) {
  return (
    <section
      className="rounded-lg border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <h3 className="text-sm font-medium uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
        {label}
      </h3>
      <ul className="mt-3 grid gap-2">
        {items.map((it) => (
          <li
            key={it.id}
            className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
            style={{ borderColor: "var(--line)" }}
          >
            <div className="flex-1">
              <p style={{ color: "var(--text)" }}>{it.kind}</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                {it.value}
              </p>
              <p className="mt-1 text-[11px] opacity-80">
                {it.extractor_version ?? "no extractor"}
              </p>
            </div>
            <form action="/review/update" method="post" className="flex flex-col gap-1">
              <input type="hidden" name="artifact_type" value={it.type} />
              <input type="hidden" name="artifact_id" value={it.id} />
              <select
                name="action"
                className="rounded border px-2 py-1 text-xs"
                style={{ borderColor: "var(--line)", background: "var(--surface-alt)", color: "var(--text)" }}
                defaultValue={it.review_status}
              >
                <option value="reviewed">Mark reviewed</option>
                <option value="flagged">Flag</option>
                <option value="unreviewed">Reset</option>
              </select>
              <input
                type="text"
                name="note"
                placeholder="Reviewer note (optional)"
                className="rounded border px-2 py-1 text-xs"
                style={{ borderColor: "var(--line)", background: "var(--surface-alt)", color: "var(--text)" }}
              />
              <button
                type="submit"
                className="rounded bg-accent/20 px-2 py-1 text-xs font-medium hover:bg-accent/30"
                style={{ color: "var(--accent-strong)" }}
              >
                Save
              </button>
            </form>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-xs" style={{ color: "var(--muted)" }}>
            No artifacts in this category.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
