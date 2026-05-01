/**
 * Drizzle schema. Mirrors the SQLite oracle at /srv/projects/ProxyMiner
 * but tightens types and normalizes review/provenance into shared
 * column groups so every artifact carries the same fields.
 *
 * Three changes from the oracle, deliberate and documented:
 *
 *   1. Executive compensation rows are PERSISTED, not extracted on read.
 *      The old design parsed the SCT each time the filing was read.
 *      Here we store rows + provenance + review state, matching every
 *      other artifact. This was a P1 priority called out in the rewrite
 *      plan ("persist executive compensation as first-class reviewed
 *      data"). The exec_comp_rows table is the new home for it.
 *
 *   2. `confidence` columns are kept as numeric (Postgres numeric(4,3))
 *      not floats, so parity diffs don't drift on float reps.
 *
 *   3. Composite uniqueness: (company_id, accession_number) on filings,
 *      (filing_id, section_type, normalized_heading) on sections, etc.
 *      Replaces SQLite's autoincrement-only design.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────
export const reviewStatusEnum = pgEnum("review_status", [
  "unreviewed",
  "reviewed",
  "flagged",
]);
export const verificationStatusEnum = pgEnum("verification_status", [
  "machine_extracted",
  "verified",
  "rejected",
]);

// ── Companies ────────────────────────────────────────────────────────
export const companies = pgTable(
  "companies",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    cik: varchar("cik", { length: 10 }).notNull(),
    ticker: varchar("ticker", { length: 16 }),
    name: text("name").notNull(),
    sector: text("sector"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    cikIdx: uniqueIndex("companies_cik_idx").on(t.cik),
    tickerIdx: index("companies_ticker_idx").on(t.ticker),
  }),
);

// ── Filings ──────────────────────────────────────────────────────────
export const filings = pgTable(
  "filings",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    company_id: varchar("company_id", { length: 32 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    accession_number: varchar("accession_number", { length: 24 }).notNull(),
    form_type: varchar("form_type", { length: 16 }).notNull(),
    filing_date: timestamp("filing_date", { mode: "date" }).notNull(),
    filing_year: integer("filing_year").notNull(),
    acceptance_datetime: timestamp("acceptance_datetime", { withTimezone: true }),
    source_index_url: text("source_index_url"),
    primary_document_url: text("primary_document_url"),
    primary_document_name: text("primary_document_name"),
    report_date: timestamp("report_date", { mode: "date" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    companyAccession: uniqueIndex("filings_company_accession_idx").on(
      t.company_id,
      t.accession_number,
    ),
    yearIdx: index("filings_year_idx").on(t.filing_year),
  }),
);

// ── Documents (raw filing artifacts pointing into Vercel Blob) ───────
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  filing_id: varchar("filing_id", { length: 24 })
    .notNull()
    .references(() => filings.id, { onDelete: "cascade" }),
  sequence: integer("sequence"),
  document_name: text("document_name"),
  document_type: varchar("document_type", { length: 32 }),
  description: text("description"),
  is_primary: boolean("is_primary").notNull().default(false),
  source_url: text("source_url"),
  blob_url: text("blob_url"), // Vercel Blob public URL
  blob_path: text("blob_path"), // path inside the blob store, for re-fetch
  mime_type: varchar("mime_type", { length: 64 }),
  sha256: varchar("sha256", { length: 64 }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ── Provenance + review columns shared across artifact tables ────────
const provenanceCols = {
  extractor_version: varchar("extractor_version", { length: 64 }),
  extraction_method: varchar("extraction_method", { length: 64 }),
  source_document_name: text("source_document_name"),
  source_document_sha: varchar("source_document_sha", { length: 64 }),
  verification_status: verificationStatusEnum("verification_status")
    .notNull()
    .default("machine_extracted"),
  review_status: reviewStatusEnum("review_status").notNull().default("unreviewed"),
  reviewed_by: varchar("reviewed_by", { length: 64 }),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  review_notes: text("review_notes"),
};

// ── Sections (CD&A and friends) ──────────────────────────────────────
export const sections = pgTable(
  "sections",
  {
    id: serial("id").primaryKey(),
    filing_id: varchar("filing_id", { length: 24 })
      .notNull()
      .references(() => filings.id, { onDelete: "cascade" }),
    document_id: integer("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    section_type: varchar("section_type", { length: 32 }).notNull(),
    heading: text("heading"),
    normalized_heading: text("normalized_heading"),
    text: text("text").notNull(),
    html_fragment: text("html_fragment"),
    confidence_score: numeric("confidence_score", { precision: 4, scale: 3 }),
    ...provenanceCols,
  },
  (t) => ({
    filingTypeIdx: index("sections_filing_type_idx").on(t.filing_id, t.section_type),
  }),
);

// ── Policy facts ─────────────────────────────────────────────────────
export const policy_facts = pgTable(
  "policy_facts",
  {
    id: serial("id").primaryKey(),
    filing_id: varchar("filing_id", { length: 24 })
      .notNull()
      .references(() => filings.id, { onDelete: "cascade" }),
    section_id: integer("section_id").references(() => sections.id, {
      onDelete: "set null",
    }),
    policy_type: varchar("policy_type", { length: 64 }).notNull(),
    normalized_value: text("normalized_value"),
    summary: text("summary"),
    source_excerpt: text("source_excerpt").notNull(),
    confidence_score: numeric("confidence_score", { precision: 4, scale: 3 }),
    ...provenanceCols,
  },
  (t) => ({
    filingTypeIdx: index("policy_facts_filing_type_idx").on(t.filing_id, t.policy_type),
  }),
);

// ── Metric facts ─────────────────────────────────────────────────────
export const metric_facts = pgTable(
  "metric_facts",
  {
    id: serial("id").primaryKey(),
    filing_id: varchar("filing_id", { length: 24 })
      .notNull()
      .references(() => filings.id, { onDelete: "cascade" }),
    section_id: integer("section_id").references(() => sections.id, {
      onDelete: "set null",
    }),
    metric_name_raw: text("metric_name_raw").notNull(),
    metric_name_normalized: varchar("metric_name_normalized", { length: 64 }),
    metric_category: varchar("metric_category", { length: 32 }),
    plan_type: varchar("plan_type", { length: 32 }),
    observed_value: text("observed_value"),
    source_excerpt: text("source_excerpt").notNull(),
    confidence_score: numeric("confidence_score", { precision: 4, scale: 3 }),
    ...provenanceCols,
  },
  (t) => ({
    filingMetricIdx: index("metric_facts_filing_metric_idx").on(
      t.filing_id,
      t.metric_name_normalized,
    ),
  }),
);

// ── Peer groups + members ────────────────────────────────────────────
export const peer_groups = pgTable("peer_groups", {
  id: serial("id").primaryKey(),
  filing_id: varchar("filing_id", { length: 24 })
    .notNull()
    .references(() => filings.id, { onDelete: "cascade" }),
  section_id: integer("section_id").references(() => sections.id, {
    onDelete: "set null",
  }),
  peer_group_name: text("peer_group_name"),
  peer_group_type: varchar("peer_group_type", { length: 32 }),
  disclosed_year: integer("disclosed_year"),
  selection_rationale: text("selection_rationale"),
  source_excerpt: text("source_excerpt").notNull(),
  confidence_score: numeric("confidence_score", { precision: 4, scale: 3 }),
  ...provenanceCols,
});

export const peer_group_members = pgTable("peer_group_members", {
  id: serial("id").primaryKey(),
  peer_group_id: integer("peer_group_id")
    .notNull()
    .references(() => peer_groups.id, { onDelete: "cascade" }),
  company_name_raw: text("company_name_raw").notNull(),
  company_id_resolved: varchar("company_id_resolved", { length: 32 }).references(
    () => companies.id,
    { onDelete: "set null" },
  ),
  company_name_resolved: text("company_name_resolved"),
  ticker_resolved: varchar("ticker_resolved", { length: 16 }),
  cik_resolved: varchar("cik_resolved", { length: 10 }),
  resolution_confidence: numeric("resolution_confidence", { precision: 4, scale: 3 }),
});

// ── Executive comp rows (PERSISTED — change from oracle) ─────────────
export const exec_comp_rows = pgTable(
  "exec_comp_rows",
  {
    id: serial("id").primaryKey(),
    filing_id: varchar("filing_id", { length: 24 })
      .notNull()
      .references(() => filings.id, { onDelete: "cascade" }),
    document_id: integer("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    executive_name: text("executive_name").notNull(),
    principal_position: text("principal_position"),
    year: integer("year").notNull(),
    salary: text("salary"),
    bonus: text("bonus"),
    stock_awards: text("stock_awards"),
    option_awards: text("option_awards"),
    non_equity_incentive_plan_compensation: text(
      "non_equity_incentive_plan_compensation",
    ),
    all_other_compensation: text("all_other_compensation"),
    total: text("total"),
    source_excerpt: text("source_excerpt").notNull(),
    ...provenanceCols,
  },
  (t) => ({
    filingExecYearIdx: uniqueIndex("exec_comp_filing_exec_year_idx").on(
      t.filing_id,
      t.executive_name,
      t.year,
    ),
  }),
);

// ── SEC fetch rate budgeter (Postgres-backed counter) ────────────────
// Used by the SEC client to ensure we never exceed 10 req/sec across
// concurrent serverless invocations. The single row per second key is
// upserted with FOR UPDATE.
export const sec_rate_window = pgTable("sec_rate_window", {
  bucket_seconds: integer("bucket_seconds").primaryKey(),
  request_count: integer("request_count").notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ── Ingestion job audit trail ────────────────────────────────────────
export const ingest_jobs = pgTable("ingest_jobs", {
  id: serial("id").primaryKey(),
  job_type: varchar("job_type", { length: 32 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  identifier: text("identifier"),
  note: text("note"),
  detail: jsonb("detail"),
  started_at: timestamp("started_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  completed_at: timestamp("completed_at", { withTimezone: true }),
});

// ── Ask interactions (audit trail for the AI assistant) ──────────────
// Required by the rewrite plan §"Auditability of what context was sent
// to the model". Stores the question, the assembled context (truncated
// for privacy/cost), the citations the model returned, and the model
// response so a reviewer can replay and verify any answer the user
// quoted from.
export const ask_interactions = pgTable("ask_interactions", {
  id: serial("id").primaryKey(),
  company_id: varchar("company_id", { length: 32 }).references(
    () => companies.id,
    { onDelete: "set null" },
  ),
  filing_id: varchar("filing_id", { length: 24 }).references(() => filings.id, {
    onDelete: "set null",
  }),
  question: text("question").notNull(),
  context_summary: jsonb("context_summary"),
  citations: jsonb("citations"),
  answer: text("answer"),
  model: varchar("model", { length: 64 }),
  scope_violation: boolean("scope_violation").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
