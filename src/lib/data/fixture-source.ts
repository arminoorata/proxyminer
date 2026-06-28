/**
 * Fixture-backed read API — used in local dev and during the period
 * before Neon Postgres is provisioned (User-Action A-002).
 *
 * The shape and field names match the Drizzle schema in
 * `src/lib/db/schema.ts` so swapping `fixture-source` for `pg-source`
 * later is a one-import change in `src/lib/services/*.ts`.
 *
 * Reads are cached at module-init for a 12-company / 32-filing set
 * (~25 MB JSON total). Memory budget is fine for local dev.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  peerGroupsForPublic,
  type FilingDetailOptions,
} from "@/lib/data/peer-groups";
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

const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

interface CompanyFixture {
  company: CompanyRow;
  filings: FilingFixture[];
}

interface FilingFixture {
  filing: FilingRow;
  documents: unknown[];
  sections: SectionRow[];
  policy_facts: PolicyFactRow[];
  metric_facts: MetricFactRow[];
  peer_groups: PeerGroupRow[];
  executive_comp: ExecutiveCompRow[];
}

let CACHE: Map<string, CompanyFixture> | null = null;

function read<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function load(): Map<string, CompanyFixture> {
  if (CACHE) return CACHE;
  const result = new Map<string, CompanyFixture>();

  if (!existsSync(FIXTURES_ROOT)) {
    CACHE = result;
    return result;
  }

  for (const company_id of readdirSync(FIXTURES_ROOT)) {
    const cdir = join(FIXTURES_ROOT, company_id);
    const company = read<CompanyRow>(join(cdir, "company.json"));
    if (!company) continue;

    const filings: FilingFixture[] = [];
    for (const filing_id of readdirSync(cdir)) {
      const fdir = join(cdir, filing_id);
      const filing = read<FilingRow>(join(fdir, "filing.json"));
      if (!filing) continue;

      filings.push({
        filing,
        documents: read<unknown[]>(join(fdir, "documents.json")) ?? [],
        sections: read<SectionRow[]>(join(fdir, "sections.json")) ?? [],
        policy_facts:
          read<PolicyFactRow[]>(join(fdir, "policy_facts.json")) ?? [],
        metric_facts:
          read<MetricFactRow[]>(join(fdir, "metric_facts.json")) ?? [],
        peer_groups: read<PeerGroupRow[]>(join(fdir, "peer_groups.json")) ?? [],
        executive_comp:
          read<ExecutiveCompRow[]>(join(fdir, "executive_comp.json")) ?? [],
      });
    }
    // Sort filings newest-first by filing_date
    filings.sort((a, b) =>
      (b.filing.filing_date ?? "").localeCompare(a.filing.filing_date ?? ""),
    );
    result.set(company_id, { company, filings });
  }

  CACHE = result;
  return result;
}

export function listCompanies(): CompanyRow[] {
  return Array.from(load().values())
    .map((c) => c.company)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCompany(companyId: string): CompanyRow | null {
  return load().get(companyId)?.company ?? null;
}

export function listFilings(companyId: string): FilingRow[] {
  return load().get(companyId)?.filings.map((f) => f.filing) ?? [];
}

export function getFilingDetail(
  filingId: string,
  options: FilingDetailOptions = {},
): FilingDetail | null {
  for (const c of load().values()) {
    const fix = c.filings.find((f) => f.filing.id === filingId);
    if (!fix) continue;
    const { filing, sections, policy_facts, metric_facts, peer_groups, executive_comp } =
      fix;
    return {
      ...filing,
      primary_document_url: filing.primary_document_url,
      sections,
      policies: policy_facts,
      metrics: metric_facts,
      peer_groups: peerGroupsForPublic(peer_groups, options),
      executive_compensation: executive_comp,
    };
  }
  return null;
}

export function getLatestFiling(
  companyId: string,
  options: FilingDetailOptions = {},
): FilingDetail | null {
  const filings = load().get(companyId)?.filings ?? [];
  if (filings.length === 0) return null;
  return getFilingDetail(filings[0].filing.id, options);
}

export function fixtureMode(): boolean {
  return !process.env.DATABASE_URL || process.env.PROXYMINER_USE_FIXTURES === "1";
}
