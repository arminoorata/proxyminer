/**
 * Unified async read API. Picks Postgres when DATABASE_URL is set,
 * falls back to fixtures when (a) pg throws, (b) pg returns empty,
 * or (c) pg returns a filing detail noticeably less rich than the
 * fixture for the same filing_id (richness gate).
 *
 * The richness gate matters during the transition window: cron may
 * have populated pg with output from an earlier MVP-grade extractor
 * that's strictly poorer than the python-mirror fixture. Until pg has
 * been re-seeded via /api/admin/seed-from-fixtures (or cron has
 * re-extracted with the parity-grade ports), the fixture wins.
 *
 * Callers should always import from this module, never from
 * `fixture-source` or `pg-source` directly.
 */
import * as fixture from "./fixture-source";
import type {
  CompanyRow,
  FilingDetail,
  FilingRow,
} from "@/lib/types";

function pgEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL) && process.env.PROXYMINER_USE_FIXTURES !== "1";
}

async function loadPg() {
  return import("./pg-source");
}

function richness(d: FilingDetail | null): number {
  if (!d) return -1;
  return (
    d.sections.length +
    d.policies.length +
    d.metrics.length +
    d.peer_groups.reduce((acc, g) => acc + 1 + g.members.length, 0) +
    d.executive_compensation.length
  );
}

export async function listCompanies(): Promise<CompanyRow[]> {
  if (pgEnabled()) {
    try {
      const pg = await loadPg();
      const rows = await pg.listCompanies();
      if (rows.length > 0) return rows;
    } catch (err) {
      console.warn("[data/source] pg listCompanies failed, falling back to fixtures:", err);
    }
  }
  return fixture.listCompanies();
}

export async function getCompany(companyId: string): Promise<CompanyRow | null> {
  if (pgEnabled()) {
    try {
      const pg = await loadPg();
      const row = await pg.getCompany(companyId);
      if (row) return row;
    } catch (err) {
      console.warn("[data/source] pg getCompany failed, falling back to fixtures:", err);
    }
  }
  return fixture.getCompany(companyId);
}

export async function listFilings(companyId: string): Promise<FilingRow[]> {
  if (pgEnabled()) {
    try {
      const pg = await loadPg();
      const rows = await pg.listFilings(companyId);
      if (rows.length > 0) return rows;
    } catch (err) {
      console.warn("[data/source] pg listFilings failed, falling back to fixtures:", err);
    }
  }
  return fixture.listFilings(companyId);
}

export async function getFilingDetail(
  filingId: string,
): Promise<FilingDetail | null> {
  if (pgEnabled()) {
    try {
      const pg = await loadPg();
      const pgDetail = await pg.getFilingDetail(filingId);
      if (pgDetail) {
        const fixtureDetail = fixture.getFilingDetail(filingId);
        if (fixtureDetail && richness(fixtureDetail) > richness(pgDetail)) {
          return fixtureDetail;
        }
        return pgDetail;
      }
    } catch (err) {
      console.warn("[data/source] pg getFilingDetail failed, falling back to fixtures:", err);
    }
  }
  return fixture.getFilingDetail(filingId);
}

export async function getLatestFiling(
  companyId: string,
): Promise<FilingDetail | null> {
  if (pgEnabled()) {
    try {
      const pg = await loadPg();
      const pgDetail = await pg.getLatestFiling(companyId);
      if (pgDetail) {
        const fixtureDetail = fixture.getLatestFiling(companyId);
        if (fixtureDetail && richness(fixtureDetail) > richness(pgDetail)) {
          return fixtureDetail;
        }
        return pgDetail;
      }
    } catch (err) {
      console.warn("[data/source] pg getLatestFiling failed, falling back to fixtures:", err);
    }
  }
  return fixture.getLatestFiling(companyId);
}

export function fixtureMode(): boolean {
  return fixture.fixtureMode();
}
