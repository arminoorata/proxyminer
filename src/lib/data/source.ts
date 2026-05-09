/**
 * Unified async read API. Picks Postgres when DATABASE_URL is set,
 * falls back to fixtures only when (a) pg throws or (b) pg returns
 * empty for the requested key.
 *
 * Earlier versions of this file ran a "richness gate" that compared
 * pg-vs-fixture artifact counts and preferred the richer side. That
 * was a transitional safety net for the period when pg held output
 * from an MVP-grade extractor that was strictly poorer than the
 * python-mirror fixture. Once pg is seeded via
 * /api/admin/seed-from-fixtures and refreshed via
 * /api/admin/reextract-facts (and ongoing weekly cron), pg becomes
 * the authoritative source — it's the only place that captures
 * filings ingested AFTER the fixture freeze. The gate became actively
 * harmful: when pg has a NEW filing year that fixture doesn't (e.g.,
 * pg has 2026, fixture has 2023-2025), comparing pg-2026 vs
 * fixture-2025 would route the page to a stale 2025 fixture detail
 * stripped of every post-freeze extractor improvement.
 *
 * Today's contract: trust pg unless it returns empty. Fixtures remain
 * the dev-mode default and the disaster-recovery floor.
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
      if (pgDetail) return pgDetail;
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
      if (pgDetail) return pgDetail;
    } catch (err) {
      console.warn("[data/source] pg getLatestFiling failed, falling back to fixtures:", err);
    }
  }
  return fixture.getLatestFiling(companyId);
}

export function fixtureMode(): boolean {
  return fixture.fixtureMode();
}
