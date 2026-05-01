CREATE TYPE "public"."review_status" AS ENUM('unreviewed', 'reviewed', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('machine_extracted', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ask_interactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" varchar(32),
	"filing_id" varchar(24),
	"question" text NOT NULL,
	"context_summary" jsonb,
	"citations" jsonb,
	"answer" text,
	"model" varchar(64),
	"scope_violation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"cik" varchar(10) NOT NULL,
	"ticker" varchar(16),
	"name" text NOT NULL,
	"sector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"sequence" integer,
	"document_name" text,
	"document_type" varchar(32),
	"description" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source_url" text,
	"blob_url" text,
	"blob_path" text,
	"mime_type" varchar(64),
	"sha256" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exec_comp_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"document_id" integer,
	"executive_name" text NOT NULL,
	"principal_position" text,
	"year" integer NOT NULL,
	"salary" text,
	"bonus" text,
	"stock_awards" text,
	"option_awards" text,
	"non_equity_incentive_plan_compensation" text,
	"all_other_compensation" text,
	"total" text,
	"source_excerpt" text NOT NULL,
	"extractor_version" varchar(64),
	"extraction_method" varchar(64),
	"source_document_name" text,
	"source_document_sha" varchar(64),
	"verification_status" "verification_status" DEFAULT 'machine_extracted' NOT NULL,
	"review_status" "review_status" DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"review_notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "filings" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"company_id" varchar(32) NOT NULL,
	"accession_number" varchar(24) NOT NULL,
	"form_type" varchar(16) NOT NULL,
	"filing_date" timestamp NOT NULL,
	"filing_year" integer NOT NULL,
	"acceptance_datetime" timestamp with time zone,
	"source_index_url" text,
	"primary_document_url" text,
	"primary_document_name" text,
	"report_date" timestamp,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"identifier" text,
	"note" text,
	"detail" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"section_id" integer,
	"metric_name_raw" text NOT NULL,
	"metric_name_normalized" varchar(64),
	"metric_category" varchar(32),
	"plan_type" varchar(32),
	"observed_value" text,
	"source_excerpt" text NOT NULL,
	"confidence_score" numeric(4, 3),
	"extractor_version" varchar(64),
	"extraction_method" varchar(64),
	"source_document_name" text,
	"source_document_sha" varchar(64),
	"verification_status" "verification_status" DEFAULT 'machine_extracted' NOT NULL,
	"review_status" "review_status" DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"review_notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "peer_group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"peer_group_id" integer NOT NULL,
	"company_name_raw" text NOT NULL,
	"company_id_resolved" varchar(32),
	"company_name_resolved" text,
	"ticker_resolved" varchar(16),
	"cik_resolved" varchar(10),
	"resolution_confidence" numeric(4, 3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "peer_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"section_id" integer,
	"peer_group_name" text,
	"peer_group_type" varchar(32),
	"disclosed_year" integer,
	"selection_rationale" text,
	"source_excerpt" text NOT NULL,
	"confidence_score" numeric(4, 3),
	"extractor_version" varchar(64),
	"extraction_method" varchar(64),
	"source_document_name" text,
	"source_document_sha" varchar(64),
	"verification_status" "verification_status" DEFAULT 'machine_extracted' NOT NULL,
	"review_status" "review_status" DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"review_notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"section_id" integer,
	"policy_type" varchar(64) NOT NULL,
	"normalized_value" text,
	"summary" text,
	"source_excerpt" text NOT NULL,
	"confidence_score" numeric(4, 3),
	"extractor_version" varchar(64),
	"extraction_method" varchar(64),
	"source_document_name" text,
	"source_document_sha" varchar(64),
	"verification_status" "verification_status" DEFAULT 'machine_extracted' NOT NULL,
	"review_status" "review_status" DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"review_notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sec_rate_window" (
	"bucket_seconds" integer PRIMARY KEY NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" varchar(24) NOT NULL,
	"document_id" integer,
	"section_type" varchar(32) NOT NULL,
	"heading" text,
	"normalized_heading" text,
	"text" text NOT NULL,
	"html_fragment" text,
	"confidence_score" numeric(4, 3),
	"extractor_version" varchar(64),
	"extraction_method" varchar(64),
	"source_document_name" text,
	"source_document_sha" varchar(64),
	"verification_status" "verification_status" DEFAULT 'machine_extracted' NOT NULL,
	"review_status" "review_status" DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"review_notes" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ask_interactions" ADD CONSTRAINT "ask_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ask_interactions" ADD CONSTRAINT "ask_interactions_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exec_comp_rows" ADD CONSTRAINT "exec_comp_rows_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exec_comp_rows" ADD CONSTRAINT "exec_comp_rows_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "filings" ADD CONSTRAINT "filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "metric_facts" ADD CONSTRAINT "metric_facts_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "metric_facts" ADD CONSTRAINT "metric_facts_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_group_members" ADD CONSTRAINT "peer_group_members_peer_group_id_peer_groups_id_fk" FOREIGN KEY ("peer_group_id") REFERENCES "public"."peer_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_group_members" ADD CONSTRAINT "peer_group_members_company_id_resolved_companies_id_fk" FOREIGN KEY ("company_id_resolved") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_groups" ADD CONSTRAINT "peer_groups_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_groups" ADD CONSTRAINT "peer_groups_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_facts" ADD CONSTRAINT "policy_facts_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_facts" ADD CONSTRAINT "policy_facts_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sections" ADD CONSTRAINT "sections_filing_id_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sections" ADD CONSTRAINT "sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_cik_idx" ON "companies" USING btree ("cik");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_ticker_idx" ON "companies" USING btree ("ticker");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exec_comp_filing_exec_year_idx" ON "exec_comp_rows" USING btree ("filing_id","executive_name","year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "filings_company_accession_idx" ON "filings" USING btree ("company_id","accession_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "filings_year_idx" ON "filings" USING btree ("filing_year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_facts_filing_metric_idx" ON "metric_facts" USING btree ("filing_id","metric_name_normalized");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_facts_filing_type_idx" ON "policy_facts" USING btree ("filing_id","policy_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sections_filing_type_idx" ON "sections" USING btree ("filing_id","section_type");