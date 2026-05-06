/**
 * Unified async read API. Picks Postgres when DATABASE_URL is set,
 * falls back to fixtures otherwise. Any thrown error from the pg path
 * also falls back to fixtures so a transient DB failure can't take
 * down the public site — the bundled fixture tree always renders the
 * pilot 12-company set.
 *
 * Callers should always import from this module, never from
 * `fixture-source` or `pg-source` directly. The fixture-source.ts
 * module is also re-exported here for the rare site that genuinely
 * needs the sync fixture-only path (parity tests, scripts).
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
      const detail = await pg.getFilingDetail(filingId);
      if (detail) return detail;
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
      const detail = await pg.getLatestFiling(companyId);
      if (detail) return detail;
    } catch (err) {
      console.warn("[data/source] pg getLatestFiling failed, falling back to fixtures:", err);
    }
  }
  return fixture.getLatestFiling(companyId);
}

export function fixtureMode(): boolean {
  return fixture.fixtureMode();
}
