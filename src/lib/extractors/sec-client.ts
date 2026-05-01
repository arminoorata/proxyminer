/**
 * SEC EDGAR client — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/sec_client.py
 *
 * Adds the centralized rate budgeter the Python version was missing
 * (Risks R-003). SEC enforces 10 req/sec per User-Agent. We use a
 * Postgres-backed sliding window so concurrent serverless invocations
 * coordinate.
 *
 * Set PROXYMINER_SEC_USER_AGENT in env (format: "Org Name email@domain.com").
 */
import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

const SUBMISSIONS_HOST = "https://data.sec.gov";
const ARCHIVES_HOST = "https://www.sec.gov";

const SEC_RATE_LIMIT_PER_SEC = 10;
const FETCH_TIMEOUT_MS = 15_000;

export class SecClient {
  private readonly userAgent: string;
  private readonly useBudgeter: boolean;

  constructor(opts: { userAgent?: string; useBudgeter?: boolean } = {}) {
    const ua = opts.userAgent ?? process.env.PROXYMINER_SEC_USER_AGENT;
    if (!ua) {
      throw new Error(
        "PROXYMINER_SEC_USER_AGENT must be set — required by SEC fair-use policy",
      );
    }
    this.userAgent = ua;
    this.useBudgeter = opts.useBudgeter ?? Boolean(process.env.DATABASE_URL);
  }

  submissionsUrl(cik: string): string {
    return `${SUBMISSIONS_HOST}/submissions/CIK${cik.padStart(10, "0")}.json`;
  }

  filingIndexUrl(cik: string, accession: string): string {
    const acc = accession.replace(/-/g, "");
    return `${ARCHIVES_HOST}/Archives/edgar/data/${cik.replace(/^0+/, "")}/${acc}/`;
  }

  filingDocumentUrl(cik: string, accession: string, documentName: string): string {
    const acc = accession.replace(/-/g, "");
    return `${ARCHIVES_HOST}/Archives/edgar/data/${cik.replace(/^0+/, "")}/${acc}/${documentName}`;
  }

  async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url, { accept: "application/json" });
    return JSON.parse(text) as T;
  }

  async fetchText(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    if (this.useBudgeter) await this.acquireRateBudget();
    const res = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: headers.accept ?? "text/html,*/*",
        ...headers,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`SEC fetch failed (${res.status}): ${url}`);
    }
    return res.text();
  }

  /**
   * Postgres-backed sliding window. Each second-bucket is a row; we
   * SELECT FOR UPDATE then upsert with a count cap. If the cap is hit,
   * we sleep until the next bucket. Cheap (one tiny insert per
   * request) and shared across all serverless invocations.
   */
  private async acquireRateBudget(): Promise<void> {
    const conn = db();
    const max_attempts = 3;
    for (let attempt = 0; attempt < max_attempts; attempt++) {
      const bucket = Math.floor(Date.now() / 1000);
      const result = await conn.execute(sql`
        INSERT INTO ${schema.sec_rate_window} (bucket_seconds, request_count, updated_at)
        VALUES (${bucket}, 1, now())
        ON CONFLICT (bucket_seconds) DO UPDATE SET
          request_count = ${schema.sec_rate_window}.request_count + 1,
          updated_at = now()
        RETURNING request_count
      `);
      const count = Number((result as unknown as { rows: { request_count: number }[] }).rows[0]?.request_count ?? 1);
      if (count <= SEC_RATE_LIMIT_PER_SEC) return;
      // Over budget for this bucket — wait until next second.
      const waitMs = 1100 - (Date.now() % 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new Error("SEC rate budget exhausted after 3 retries");
  }
}
