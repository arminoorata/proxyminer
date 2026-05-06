/**
 * Postgres-backed read API. Same shape as fixture-source.ts so the
 * unified source.ts can swap them based on env.
 *
 * Reads are aggregated per filing via a small fan-out (filing row +
 * sections + policies + metrics + peer groups + members + exec comp).
 * That's 6 queries per company-page render — fine for the pilot
 * 12-company set, and Drizzle's prepared-statement caching pays for
 * itself across requests.
 */
import { eq, inArray, asc, desc } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import type {
  CompanyRow,
  ExecutiveCompRow,
  FilingDetail,
  FilingRow,
  MetricFactRow,
  PeerGroupRow,
  PolicyFactRow,
  SectionRow,
} from "@/lib/types";

function toNumber(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDateString(v: Date | string | null): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.toISOString().slice(0, 10);
}

function toIsoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return v.toISOString();
}

function mapCompany(row: typeof schema.companies.$inferSelect): CompanyRow {
  return {
    id: row.id,
    cik: row.cik,
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
  };
}

function mapFiling(row: typeof schema.filings.$inferSelect): FilingRow {
  return {
    id: row.id,
    company_id: row.company_id,
    accession_number: row.accession_number,
    form_type: row.form_type,
    filing_date: toDateString(row.filing_date),
    filing_year: row.filing_year,
    acceptance_datetime: toIsoOrNull(row.acceptance_datetime),
    source_index_url: row.source_index_url,
    primary_document_url: row.primary_document_url,
    primary_document_name: row.primary_document_name,
    report_date: toIsoOrNull(row.report_date),
  };
}

export async function listCompanies(): Promise<CompanyRow[]> {
  const rows = await db()
    .select()
    .from(schema.companies)
    .orderBy(asc(schema.companies.name));
  return rows.map(mapCompany);
}

export async function getCompany(companyId: string): Promise<CompanyRow | null> {
  const rows = await db()
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  return rows[0] ? mapCompany(rows[0]) : null;
}

export async function listFilings(companyId: string): Promise<FilingRow[]> {
  const rows = await db()
    .select()
    .from(schema.filings)
    .where(eq(schema.filings.company_id, companyId))
    .orderBy(desc(schema.filings.filing_date));
  return rows.map(mapFiling);
}

export async function getFilingDetail(
  filingId: string,
): Promise<FilingDetail | null> {
  const conn = db();
  const filingRow = await conn
    .select()
    .from(schema.filings)
    .where(eq(schema.filings.id, filingId))
    .limit(1);
  if (filingRow.length === 0) return null;
  const filing = mapFiling(filingRow[0]);

  const [
    sectionsRows,
    policiesRows,
    metricsRows,
    peerGroupsRows,
    execCompRows,
  ] = await Promise.all([
    conn
      .select()
      .from(schema.sections)
      .where(eq(schema.sections.filing_id, filingId)),
    conn
      .select()
      .from(schema.policy_facts)
      .where(eq(schema.policy_facts.filing_id, filingId)),
    conn
      .select()
      .from(schema.metric_facts)
      .where(eq(schema.metric_facts.filing_id, filingId)),
    conn
      .select()
      .from(schema.peer_groups)
      .where(eq(schema.peer_groups.filing_id, filingId)),
    conn
      .select()
      .from(schema.exec_comp_rows)
      .where(eq(schema.exec_comp_rows.filing_id, filingId)),
  ]);

  const peerGroupIds = peerGroupsRows.map((g) => g.id);
  const memberRows =
    peerGroupIds.length > 0
      ? await conn
          .select()
          .from(schema.peer_group_members)
          .where(inArray(schema.peer_group_members.peer_group_id, peerGroupIds))
      : [];

  const sections: SectionRow[] = sectionsRows.map((s) => ({
    id: s.id,
    filing_id: s.filing_id,
    document_id: s.document_id,
    section_type: s.section_type,
    heading: s.heading,
    normalized_heading: s.normalized_heading,
    text: s.text,
    html_fragment: s.html_fragment,
    confidence_score: toNumber(s.confidence_score),
    extractor_version: s.extractor_version,
    extraction_method: s.extraction_method,
    source_document_name: s.source_document_name,
    source_document_sha: s.source_document_sha,
    verification_status: s.verification_status,
    review_status: s.review_status,
    reviewed_by: s.reviewed_by,
    reviewed_at: toIsoOrNull(s.reviewed_at),
    review_notes: s.review_notes,
  }));

  const policies: PolicyFactRow[] = policiesRows.map((p) => ({
    id: p.id,
    filing_id: p.filing_id,
    section_id: p.section_id,
    policy_type: p.policy_type,
    normalized_value: p.normalized_value,
    summary: p.summary,
    source_excerpt: p.source_excerpt,
    confidence_score: toNumber(p.confidence_score),
    extractor_version: p.extractor_version,
    extraction_method: p.extraction_method,
    source_document_name: p.source_document_name,
    source_document_sha: p.source_document_sha,
    verification_status: p.verification_status,
    review_status: p.review_status,
    reviewed_by: p.reviewed_by,
    reviewed_at: toIsoOrNull(p.reviewed_at),
    review_notes: p.review_notes,
  }));

  const metrics: MetricFactRow[] = metricsRows.map((m) => ({
    id: m.id,
    filing_id: m.filing_id,
    section_id: m.section_id,
    metric_name_raw: m.metric_name_raw,
    metric_name_normalized: m.metric_name_normalized,
    metric_category: m.metric_category,
    plan_type: m.plan_type,
    observed_value: m.observed_value,
    source_excerpt: m.source_excerpt,
    confidence_score: toNumber(m.confidence_score),
    extractor_version: m.extractor_version,
    extraction_method: m.extraction_method,
    source_document_name: m.source_document_name,
    source_document_sha: m.source_document_sha,
    verification_status: m.verification_status,
    review_status: m.review_status,
    reviewed_by: m.reviewed_by,
    reviewed_at: toIsoOrNull(m.reviewed_at),
    review_notes: m.review_notes,
  }));

  const membersByGroup = new Map<number, typeof memberRows>();
  for (const m of memberRows) {
    const list = membersByGroup.get(m.peer_group_id) ?? [];
    list.push(m);
    membersByGroup.set(m.peer_group_id, list);
  }
  const peer_groups: PeerGroupRow[] = peerGroupsRows.map((g) => ({
    id: g.id,
    filing_id: g.filing_id,
    section_id: g.section_id,
    peer_group_name: g.peer_group_name,
    peer_group_type: g.peer_group_type,
    disclosed_year: g.disclosed_year,
    selection_rationale: g.selection_rationale,
    source_excerpt: g.source_excerpt,
    confidence_score: toNumber(g.confidence_score),
    extractor_version: g.extractor_version,
    extraction_method: g.extraction_method,
    source_document_name: g.source_document_name,
    source_document_sha: g.source_document_sha,
    verification_status: g.verification_status,
    review_status: g.review_status,
    reviewed_by: g.reviewed_by,
    reviewed_at: toIsoOrNull(g.reviewed_at),
    review_notes: g.review_notes,
    members: (membersByGroup.get(g.id) ?? []).map((m) => ({
      id: m.id,
      peer_group_id: m.peer_group_id,
      company_name_raw: m.company_name_raw,
      company_id_resolved: m.company_id_resolved,
      company_name_resolved: m.company_name_resolved,
      ticker_resolved: m.ticker_resolved,
      cik_resolved: m.cik_resolved,
      resolution_confidence: toNumber(m.resolution_confidence),
    })),
  }));

  const executive_compensation: ExecutiveCompRow[] = execCompRows.map((e) => ({
    executive_name: e.executive_name,
    principal_position: e.principal_position,
    year: e.year,
    salary: e.salary,
    bonus: e.bonus,
    stock_awards: e.stock_awards,
    option_awards: e.option_awards,
    non_equity_incentive_plan_compensation: e.non_equity_incentive_plan_compensation,
    all_other_compensation: e.all_other_compensation,
    total: e.total,
    source_excerpt: e.source_excerpt,
  }));

  return {
    ...filing,
    primary_document_url: filing.primary_document_url,
    sections,
    policies,
    metrics,
    peer_groups,
    executive_compensation,
  };
}

export async function getLatestFiling(
  companyId: string,
): Promise<FilingDetail | null> {
  const filings = await listFilings(companyId);
  if (filings.length === 0) return null;
  return getFilingDetail(filings[0].id);
}
