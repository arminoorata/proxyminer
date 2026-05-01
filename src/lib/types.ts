// Core domain types shared by extractors, services, and routes. Mirrors
// the Python dataclasses in /srv/projects/ProxyMiner/apps/api/app/services
// so the parity comparator can deserialize fixtures into these directly.

export type ReviewStatus = "unreviewed" | "reviewed" | "flagged";
export type VerificationStatus = "machine_extracted" | "verified" | "rejected";

export interface ProvenanceMeta {
  extractor_version: string | null;
  extraction_method: string | null;
  source_document_name: string | null;
  source_document_sha: string | null;
  verification_status: VerificationStatus;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

export interface CompanyRow {
  id: string;
  cik: string;
  ticker: string | null;
  name: string;
  sector: string | null;
}

export interface FilingRow {
  id: string;
  company_id: string;
  accession_number: string;
  form_type: string;
  filing_date: string;
  filing_year: number;
  acceptance_datetime: string | null;
  source_index_url: string | null;
  primary_document_url: string | null;
  primary_document_name: string | null;
  report_date: string | null;
}

export interface DocumentRow {
  id: string;
  filing_id: string;
  sequence: number | null;
  document_name: string | null;
  document_type: string | null;
  description: string | null;
  is_primary: boolean | number;
  source_url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  sha256: string | null;
}

export interface SectionRow extends ProvenanceMeta {
  id: number | string;
  filing_id: string;
  document_id: number | string | null;
  section_type: string;
  heading: string | null;
  normalized_heading: string | null;
  text: string;
  html_fragment: string | null;
  confidence_score: number | null;
}

export interface PolicyFactRow extends ProvenanceMeta {
  id: number | string;
  filing_id: string;
  section_id: number | string | null;
  policy_type: string;
  normalized_value: string | null;
  summary: string | null;
  source_excerpt: string;
  confidence_score: number | null;
}

export interface MetricFactRow extends ProvenanceMeta {
  id: number | string;
  filing_id: string;
  section_id: number | string | null;
  metric_name_raw: string;
  metric_name_normalized: string | null;
  metric_category: string | null;
  plan_type: string | null;
  observed_value: string | null;
  source_excerpt: string;
  confidence_score: number | null;
}

export interface PeerGroupMemberRow {
  id: number | string;
  peer_group_id: number | string;
  company_name_raw: string;
  company_id_resolved: string | null;
  company_name_resolved: string | null;
  ticker_resolved: string | null;
  cik_resolved: string | null;
  resolution_confidence: number | null;
}

export interface PeerGroupRow extends ProvenanceMeta {
  id: number | string;
  filing_id: string;
  section_id: number | string | null;
  peer_group_name: string | null;
  peer_group_type: string | null;
  disclosed_year: number | null;
  selection_rationale: string | null;
  source_excerpt: string;
  confidence_score: number | null;
  members: PeerGroupMemberRow[];
}

export interface ExecutiveCompRow {
  executive_name: string;
  principal_position: string | null;
  year: number;
  salary: string | null;
  bonus: string | null;
  stock_awards: string | null;
  option_awards: string | null;
  non_equity_incentive_plan_compensation: string | null;
  all_other_compensation: string | null;
  total: string | null;
  source_excerpt: string;
}

// Aggregated read shape for the company-page route handler. Mirrors
// FilingDetail in the Python API so the UI can read the same shape
// from either backend during cutover.
export interface FilingDetail extends FilingRow {
  primary_document_url: string | null;
  sections: SectionRow[];
  policies: PolicyFactRow[];
  peer_groups: PeerGroupRow[];
  metrics: MetricFactRow[];
  executive_compensation: ExecutiveCompRow[];
}
