/**
 * Fixture → Postgres loader. Pulls the rich Python-extracted artifacts
 * (sections + policy_facts + metric_facts + peer_groups + members +
 * exec_comp_rows) from the bundled `.fixtures/by-filing/` tree and
 * upserts them into Neon. Used by both
 * `scripts/migrate_to_postgres.ts` (one-shot CLI) and the
 * `/api/admin/seed-from-fixtures` route (in-Vercel one-shot).
 *
 * Per-filing artifacts use delete-then-insert keyed on filing_id —
 * mirrors `ingest-service.ts` so the same filing_id ends up with the
 * same shape regardless of which path wrote it.
 *
 * The shape of the fixture JSON is the same as the Drizzle row shape,
 * minus IDs and timestamps. We deliberately preserve the Python
 * `extractor_version` ("fact_extractor.v1", "peer_extractor.v1",
 * "executive_comp_extractor.v1") on the seed path so downstream
 * provenance reflects the real oracle, not the TS port.
 */
import type { eq as DrizzleEq } from "drizzle-orm";

interface SeedDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  eq: typeof DrizzleEq;
  fs: {
    existsSync: (p: string) => boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: any;
    readdirSync: (p: string) => string[];
  };
  path: { join: (...parts: string[]) => string };
}

export interface SeedCounts {
  companies: number;
  filings: number;
  sections: number;
  policy_facts: number;
  metric_facts: number;
  peer_groups: number;
  peer_group_members: number;
  exec_comp_rows: number;
}

export async function seedFromFixtureTree(
  root: string,
  deps: SeedDeps,
): Promise<SeedCounts> {
  const counts: SeedCounts = {
    companies: 0,
    filings: 0,
    sections: 0,
    policy_facts: 0,
    metric_facts: 0,
    peer_groups: 0,
    peer_group_members: 0,
    exec_comp_rows: 0,
  };
  const { db, schema, eq, fs, path } = deps;
  const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;

  // Track which company IDs actually exist in the companies table so
  // peer_group_members.company_id_resolved can be nulled when the
  // resolved peer isn't one we track. The FK constraint requires this.
  const trackedCompanyIds = new Set<string>();

  for (const companyId of fs.readdirSync(root)) {
    const cdir = path.join(root, companyId);
    const companyJson = path.join(cdir, "company.json");
    if (!fs.existsSync(companyJson)) continue;
    const company = readJson<{
      id: string;
      cik: string;
      ticker: string | null;
      name: string;
      sector: string | null;
    }>(companyJson);

    await db
      .insert(schema.companies)
      .values({ ...company })
      .onConflictDoUpdate({
        target: schema.companies.id,
        set: { name: company.name, ticker: company.ticker, sector: company.sector },
      });
    trackedCompanyIds.add(company.id);
    counts.companies++;

    for (const filingId of fs.readdirSync(cdir)) {
      const fdir = path.join(cdir, filingId);
      const filingJson = path.join(fdir, "filing.json");
      if (!fs.existsSync(filingJson)) continue;
      const filing = readJson<{
        id: string;
        company_id: string;
        accession_number: string;
        form_type: string;
        filing_date: string;
        filing_year: number;
        primary_document_url: string | null;
        primary_document_name: string | null;
        report_date?: string | null;
      }>(filingJson);

      await db
        .insert(schema.filings)
        .values({
          id: filing.id,
          company_id: filing.company_id,
          accession_number: filing.accession_number,
          form_type: filing.form_type,
          filing_date: new Date(filing.filing_date),
          filing_year: filing.filing_year,
          primary_document_url: filing.primary_document_url,
          primary_document_name: filing.primary_document_name,
          report_date: filing.report_date ? new Date(filing.report_date) : null,
        })
        .onConflictDoNothing();
      counts.filings++;

      // Sections: delete + insert keyed on filing_id.
      await db
        .delete(schema.sections)
        .where(eq(schema.sections.filing_id, filing.id));
      const sectionsPath = path.join(fdir, "sections.json");
      if (fs.existsSync(sectionsPath)) {
        const sections = readJson<Record<string, unknown>[]>(sectionsPath);
        if (sections.length > 0) {
          await db.insert(schema.sections).values(
            sections.map((s) => ({
              filing_id: filing.id,
              section_type: String(s.section_type ?? "cd_and_a"),
              heading: (s.heading as string) ?? null,
              normalized_heading: (s.normalized_heading as string) ?? null,
              text: String(s.text ?? ""),
              html_fragment: (s.html_fragment as string) ?? null,
              confidence_score: s.confidence_score == null ? null : String(s.confidence_score),
              extractor_version: (s.extractor_version as string) ?? null,
              extraction_method: (s.extraction_method as string) ?? null,
            })),
          );
          counts.sections += sections.length;
        }
      }

      // Policy facts.
      await db
        .delete(schema.policy_facts)
        .where(eq(schema.policy_facts.filing_id, filing.id));
      const policyPath = path.join(fdir, "policy_facts.json");
      if (fs.existsSync(policyPath)) {
        const rows = readJson<Record<string, unknown>[]>(policyPath);
        if (rows.length > 0) {
          await db.insert(schema.policy_facts).values(
            rows.map((p) => ({
              filing_id: filing.id,
              policy_type: String(p.policy_type ?? ""),
              normalized_value: (p.normalized_value as string) ?? null,
              summary: (p.summary as string) ?? null,
              source_excerpt: String(p.source_excerpt ?? ""),
              confidence_score: p.confidence_score == null ? null : String(p.confidence_score),
              extractor_version: (p.extractor_version as string) ?? null,
              extraction_method: (p.extraction_method as string) ?? null,
            })),
          );
          counts.policy_facts += rows.length;
        }
      }

      // Metric facts.
      await db
        .delete(schema.metric_facts)
        .where(eq(schema.metric_facts.filing_id, filing.id));
      const metricPath = path.join(fdir, "metric_facts.json");
      if (fs.existsSync(metricPath)) {
        const rows = readJson<Record<string, unknown>[]>(metricPath);
        if (rows.length > 0) {
          await db.insert(schema.metric_facts).values(
            rows.map((m) => ({
              filing_id: filing.id,
              metric_name_raw: String(m.metric_name_raw ?? ""),
              metric_name_normalized: (m.metric_name_normalized as string) ?? null,
              metric_category: (m.metric_category as string) ?? null,
              plan_type: (m.plan_type as string) ?? null,
              observed_value: (m.observed_value as string) ?? null,
              source_excerpt: String(m.source_excerpt ?? ""),
              confidence_score: m.confidence_score == null ? null : String(m.confidence_score),
              extractor_version: (m.extractor_version as string) ?? null,
              extraction_method: (m.extraction_method as string) ?? null,
            })),
          );
          counts.metric_facts += rows.length;
        }
      }

      // Peer groups + members.
      await db
        .delete(schema.peer_groups)
        .where(eq(schema.peer_groups.filing_id, filing.id));
      const peerPath = path.join(fdir, "peer_groups.json");
      if (fs.existsSync(peerPath)) {
        const groups = readJson<
          {
            peer_group_name: string | null;
            peer_group_type: string | null;
            disclosed_year: number | null;
            selection_rationale: string | null;
            source_excerpt: string;
            confidence_score: number | string | null;
            extractor_version: string | null;
            extraction_method: string | null;
            verification_status?: string | null;
            review_status?: string | null;
            review_notes?: string | null;
            members: Record<string, unknown>[];
          }[]
        >(peerPath);
        for (const g of groups) {
          const [inserted] = await db
            .insert(schema.peer_groups)
            .values({
              filing_id: filing.id,
              peer_group_name: g.peer_group_name,
              peer_group_type: g.peer_group_type,
              disclosed_year: g.disclosed_year,
              selection_rationale: g.selection_rationale,
              source_excerpt: g.source_excerpt,
              confidence_score: g.confidence_score == null ? null : String(g.confidence_score),
              extractor_version: g.extractor_version,
              extraction_method: g.extraction_method,
              verification_status: g.verification_status ?? "machine_extracted",
              review_status: g.review_status ?? "unreviewed",
              review_notes: g.review_notes ?? null,
            })
            .returning({ id: schema.peer_groups.id });
          counts.peer_groups++;
          if (g.members && g.members.length > 0 && inserted) {
            await db.insert(schema.peer_group_members).values(
              g.members.map((m) => {
                const resolvedId = (m.company_id_resolved as string) ?? null;
                return {
                  peer_group_id: inserted.id,
                  company_name_raw: String(m.company_name_raw ?? ""),
                  company_id_resolved:
                    resolvedId && trackedCompanyIds.has(resolvedId) ? resolvedId : null,
                  company_name_resolved: (m.company_name_resolved as string) ?? null,
                  ticker_resolved: (m.ticker_resolved as string) ?? null,
                  cik_resolved: (m.cik_resolved as string) ?? null,
                  resolution_confidence:
                    m.resolution_confidence == null ? null : String(m.resolution_confidence),
                };
              }),
            );
            counts.peer_group_members += g.members.length;
          }
        }
      }

      // Exec comp rows.
      await db
        .delete(schema.exec_comp_rows)
        .where(eq(schema.exec_comp_rows.filing_id, filing.id));
      const execPath = path.join(fdir, "executive_comp.json");
      if (fs.existsSync(execPath)) {
        const rows = readJson<Record<string, unknown>[]>(execPath);
        if (rows.length > 0) {
          await db.insert(schema.exec_comp_rows).values(
            rows.map((r) => ({
              filing_id: filing.id,
              executive_name: String(r.executive_name ?? ""),
              principal_position: (r.principal_position as string) ?? null,
              year: Number(r.year),
              salary: (r.salary as string) ?? null,
              bonus: (r.bonus as string) ?? null,
              stock_awards: (r.stock_awards as string) ?? null,
              option_awards: (r.option_awards as string) ?? null,
              non_equity_incentive_plan_compensation:
                (r.non_equity_incentive_plan_compensation as string) ?? null,
              all_other_compensation: (r.all_other_compensation as string) ?? null,
              total: (r.total as string) ?? null,
              source_excerpt: String(r.source_excerpt ?? ""),
              extractor_version: "executive_comp_extractor.v1",
              extraction_method: "fixture-seed",
            })),
          );
          counts.exec_comp_rows += rows.length;
        }
      }
    }
  }

  return counts;
}
