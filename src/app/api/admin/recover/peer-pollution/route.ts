/**
 * Surgical DB-only cleanup of stale polluted peer_group_members rows.
 *
 *   POST /api/admin/recover/peer-pollution
 *     -H "Authorization: Bearer $PROXYMINER_ADMIN_API_TOKEN"
 *     -d '{
 *       "parents":  ["crm", "nflx", "qcom"],
 *       "suspects": ["HEPS", "KFII", "TBTC", "FIVE", "ABVE", "SFWJ"],
 *       "confirm":  false
 *     }'
 *
 * Why this exists — Phase 11 / 11.5 / 16 fixed the resolver that
 * produced bogus single-token alias matches like "below" → FIVE, but
 * the bad rows live in `peer_group_members` from earlier ingest
 * runs. Normally a re-ingest of the parent via `/api/admin/ingest`
 * rewrites those rows cleanly. When the Vercel egress quota blocks
 * SEC fetches, that path is unavailable (ingestion fetches the
 * submissions JSON + filing HTML). This route performs the equivalent
 * cleanup using only Postgres — no SEC, no Blob, no outbound fetch.
 *
 * Safety contract:
 *   - Requires PROXYMINER_ADMIN_API_TOKEN bearer auth.
 *   - Defaults to dry-run (`confirm: false`). Returns the exact set of
 *     rows that WOULD be deleted, grouped by parent + filing.
 *   - Targets only members whose ticker_resolved is in the suspect
 *     allowlist AND whose peer_group belongs to one of the listed
 *     parent companies. Never deletes a whole peer group; never
 *     deletes a member that isn't in the suspect set.
 *   - Hard caps: parents ≤ 20, suspects ≤ 100, row count ≤ 500. Any
 *     overflow aborts with `unexpected_scope` before any write.
 *   - The actual DELETE is one statement bounded by member ids that
 *     the dry-run reported — no JOIN-and-delete across rows the
 *     caller didn't see.
 *
 * Response shape:
 *   { dry_run: true,  scope: {...},  rows: [...] }                   // confirm: false
 *   { dry_run: false, scope: {...},  deleted: <n>, rows: [...] }     // confirm: true
 *   { error, message }                                                // any abort
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_PARENTS = 20;
const MAX_SUSPECTS = 100;
const MAX_ROWS_AFFECTED = 500;

interface Body {
  parents?: unknown;
  suspects?: unknown;
  confirm?: unknown;
}

interface AffectedRow {
  member_id: number;
  company_id: string;
  company_ticker: string | null;
  filing_id: string;
  ticker_resolved: string | null;
  company_name_raw: string;
}

function normalizeStringList(v: unknown, label: string, max: number): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    const cleaned = raw.trim();
    if (cleaned.length > 32) {
      throw new Error(`${label} entry too long: ${cleaned.slice(0, 32)}…`);
    }
    if (!/^[A-Za-z0-9.\-]+$/.test(cleaned)) {
      throw new Error(`${label} entry has invalid characters: ${cleaned}`);
    }
    out.push(cleaned);
  }
  if (out.length === 0) {
    throw new Error(`${label} must contain at least one entry`);
  }
  if (out.length > max) {
    throw new Error(`${label} too large (max ${max})`);
  }
  return Array.from(new Set(out));
}

export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "expected JSON body" },
      { status: 400 },
    );
  }

  let parentsRaw: string[];
  let suspectsRaw: string[];
  try {
    parentsRaw = normalizeStringList(body.parents, "parents", MAX_PARENTS);
    suspectsRaw = normalizeStringList(body.suspects, "suspects", MAX_SUSPECTS);
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_input",
        message: err instanceof Error ? err.message : "invalid input",
      },
      { status: 400 },
    );
  }

  // Parents identify rows by either company.id (lower-case ticker) or
  // company.ticker (upper-case SEC form). Try both forms so the caller
  // can use whichever they have on hand.
  const parentIds = parentsRaw.map((p) => p.toLowerCase());
  const parentTickers = parentsRaw.map((p) => p.toUpperCase());

  // Suspect ticker matching is uppercase — that's the form stored in
  // peer_group_members.ticker_resolved per the resolver convention.
  const suspectTickers = suspectsRaw.map((s) => s.toUpperCase());

  const confirm = body.confirm === true;
  const database = db();

  // 1. Resolve the parent company.id set defensively so subsequent
  //    operations target known rows only.
  const parentCompanies = await database
    .select({
      id: schema.companies.id,
      ticker: schema.companies.ticker,
    })
    .from(schema.companies)
    .where(
      or(
        inArray(schema.companies.id, parentIds),
        inArray(schema.companies.ticker, parentTickers),
      ),
    );

  if (parentCompanies.length === 0) {
    return NextResponse.json(
      {
        error: "no_parents_matched",
        message: "none of the requested parents resolve to a company row",
        requested: parentsRaw,
      },
      { status: 404 },
    );
  }

  const resolvedParentIds = parentCompanies.map((c) => c.id);

  // 2. SELECT the rows that match: members whose ticker_resolved is in
  //    the suspect list AND whose owning filing belongs to a resolved
  //    parent. This is the exact row set we'll delete.
  const rows: AffectedRow[] = await database
    .select({
      member_id: schema.peer_group_members.id,
      company_id: schema.companies.id,
      company_ticker: schema.companies.ticker,
      filing_id: schema.filings.id,
      ticker_resolved: schema.peer_group_members.ticker_resolved,
      company_name_raw: schema.peer_group_members.company_name_raw,
    })
    .from(schema.peer_group_members)
    .innerJoin(
      schema.peer_groups,
      eq(schema.peer_groups.id, schema.peer_group_members.peer_group_id),
    )
    .innerJoin(schema.filings, eq(schema.filings.id, schema.peer_groups.filing_id))
    .innerJoin(schema.companies, eq(schema.companies.id, schema.filings.company_id))
    .where(
      and(
        inArray(schema.companies.id, resolvedParentIds),
        inArray(schema.peer_group_members.ticker_resolved, suspectTickers),
      ),
    );

  // 3. Sanity gate: refuse to write if the scope explodes.
  if (rows.length > MAX_ROWS_AFFECTED) {
    return NextResponse.json(
      {
        error: "unexpected_scope",
        message: `would affect ${rows.length} rows (max ${MAX_ROWS_AFFECTED}). Narrow parents or suspects.`,
      },
      { status: 422 },
    );
  }

  // 4. Group the row set for the caller-facing summary.
  const byParent: Record<string, AffectedRow[]> = {};
  for (const r of rows) {
    const key = r.company_id;
    (byParent[key] ?? (byParent[key] = [])).push(r);
  }
  const summary = Object.entries(byParent).map(([parent, members]) => ({
    parent,
    member_count: members.length,
    distinct_filings: new Set(members.map((m) => m.filing_id)).size,
    distinct_suspects: Array.from(
      new Set(members.map((m) => m.ticker_resolved ?? "")),
    ),
  }));

  const scope = {
    parents_requested: parentsRaw,
    parents_resolved: resolvedParentIds,
    suspects: suspectTickers,
    rows_affected: rows.length,
    summary,
  };

  if (!confirm) {
    return NextResponse.json({
      dry_run: true,
      scope,
      rows: rows.slice(0, 200),
      message:
        rows.length === 0
          ? "No matching members. Nothing to delete."
          : `Would delete ${rows.length} peer_group_members rows across ${summary.length} parent(s). Re-POST with \`confirm: true\` to execute.`,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({
      dry_run: false,
      scope,
      deleted: 0,
      rows: [],
    });
  }

  // 5. Delete only the precise member ids reported in the dry-run set.
  //    Bounded by id list — no JOIN-and-delete that could affect rows
  //    the caller didn't see.
  const ids = rows.map((r) => r.member_id);
  await database
    .delete(schema.peer_group_members)
    .where(inArray(schema.peer_group_members.id, ids));

  return NextResponse.json({
    dry_run: false,
    scope,
    deleted: ids.length,
    rows: rows.slice(0, 200),
  });
}
