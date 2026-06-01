#!/usr/bin/env node
/**
 * Freeze fixture JSON from the live Postgres-backed ProxyMiner dataset.
 *
 * This is the post-Neon-reset fixture path. The old Python freezer dumps the
 * sibling SQLite oracle under /srv/projects/ProxyMiner; that is useful for
 * original parity work, but it is not the production source of truth after the
 * Vercel/Postgres app has been re-ingested and surgically recovered.
 *
 * Required env:
 *   DATABASE_URL
 *
 * Optional env:
 *   BLOB_READ_WRITE_TOKEN         Fetch source.html from Vercel Blob.
 *   PROXYMINER_FIXTURE_COMPANIES  Comma-separated company ids. Defaults to the
 *                                 existing fixture company dirs, or the pilot
 *                                 cohort if fixtures are absent.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { head } from "@vercel/blob";
import postgres from "postgres";

import { KNOWN_PENDING_POLLUTION } from "./lib/known-pending-pollution.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, ".fixtures");
const BY_FILING = join(FIXTURES, "by-filing");
const TMP_BY_FILING = join(FIXTURES, ".by-filing.tmp");
const OLD_BY_FILING = join(FIXTURES, ".by-filing.old");

const PILOT_COMPANIES = [
  "aapl",
  "adbe",
  "amzn",
  "avgo",
  "crm",
  "googl",
  "meta",
  "msft",
  "nflx",
  "nvda",
  "orcl",
  "qcom",
];

function readCompanies() {
  const explicit = process.env.PROXYMINER_FIXTURE_COMPANIES;
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (existsSync(BY_FILING)) {
    const companies = readdirSync(BY_FILING)
      .filter((name) => existsSync(join(BY_FILING, name, "company.json")))
      .sort();
    if (companies.length > 0) return companies;
  }
  return PILOT_COMPANIES;
}

function json(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function provenance(row) {
  return {
    extractor_version: row.extractor_version ?? null,
    extraction_method: row.extraction_method ?? null,
    source_document_name: row.source_document_name ?? null,
    source_document_sha: row.source_document_sha ?? null,
    verification_status: row.verification_status ?? "machine_extracted",
    review_status: row.review_status ?? "unreviewed",
    reviewed_by: row.reviewed_by ?? null,
    reviewed_at: toIso(row.reviewed_at),
    review_notes: row.review_notes ?? null,
  };
}

function mapCompany(c) {
  return {
    id: c.id,
    cik: c.cik,
    ticker: c.ticker,
    name: c.name,
    sector: c.sector,
  };
}

function mapFiling(f) {
  return {
    id: f.id,
    company_id: f.company_id,
    accession_number: f.accession_number,
    filing_date: toDate(f.filing_date),
    filing_year: f.filing_year,
    form_type: f.form_type,
    acceptance_datetime: toIso(f.acceptance_datetime),
    source_index_url: f.source_index_url,
    primary_document_url: f.primary_document_url,
    primary_document_name: f.primary_document_name,
    report_date: toDate(f.report_date),
  };
}

function mapSection(s) {
  return {
    id: s.id,
    filing_id: s.filing_id,
    document_id: s.document_id,
    section_type: s.section_type,
    heading: s.heading,
    normalized_heading: s.normalized_heading,
    text: s.text,
    html_fragment: s.html_fragment,
    confidence_score: toNumber(s.confidence_score),
    ...provenance(s),
  };
}

function mapPolicy(p) {
  return {
    id: p.id,
    filing_id: p.filing_id,
    section_id: p.section_id,
    policy_type: p.policy_type,
    normalized_value: p.normalized_value,
    summary: p.summary,
    source_excerpt: p.source_excerpt,
    confidence_score: toNumber(p.confidence_score),
    ...provenance(p),
  };
}

function mapMetric(m) {
  return {
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
    ...provenance(m),
  };
}

function mapExec(e) {
  return {
    executive_name: e.executive_name,
    principal_position: e.principal_position,
    year: e.year,
    salary: e.salary,
    bonus: e.bonus,
    stock_awards: e.stock_awards,
    option_awards: e.option_awards,
    non_equity_incentive_plan_compensation:
      e.non_equity_incentive_plan_compensation,
    all_other_compensation: e.all_other_compensation,
    total: e.total,
    source_excerpt: e.source_excerpt,
  };
}

function reviewCounts(rows) {
  const out = { unreviewed: 0, reviewed: 0, flagged: 0, other: 0 };
  for (const row of rows) {
    const status = String(row.review_status ?? "unreviewed").toLowerCase();
    if (status in out) out[status]++;
    else out.other++;
  }
  return out;
}

function replaceFixtureTree() {
  rmSync(OLD_BY_FILING, { recursive: true, force: true });
  if (!existsSync(BY_FILING)) {
    renameSync(TMP_BY_FILING, BY_FILING);
    return;
  }

  renameSync(BY_FILING, OLD_BY_FILING);
  try {
    renameSync(TMP_BY_FILING, BY_FILING);
  } catch (err) {
    renameSync(OLD_BY_FILING, BY_FILING);
    throw err;
  }
  rmSync(OLD_BY_FILING, { recursive: true, force: true });
}

async function maybeFetchSourceHtml(companyId, filingId, docName, target, oldPath) {
  if (!docName) return { sha: null, bytes: 0, source: "missing-doc-name" };

  const key = `${companyId}/${filingId}/${docName}`;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const meta = await head(key);
      const res = await fetch(meta.url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(target, buf);
        return { sha: sha256(buf), bytes: buf.length, source: "blob", key };
      }
    } catch (err) {
      console.warn(
        `[source.html] ${companyId}/${filingId}: Blob fetch failed (${err instanceof Error ? err.message : String(err)}); trying old fixture copy.`,
      );
    }
  }

  if (existsSync(oldPath)) {
    cpSync(oldPath, target);
    const buf = readFileSync(target);
    return { sha: sha256(buf), bytes: buf.length, source: "existing-fixture", key };
  }
  return { sha: null, bytes: 0, source: "missing", key };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }

  const companies = readCompanies();
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  rmSync(TMP_BY_FILING, { recursive: true, force: true });
  mkdirSync(TMP_BY_FILING, { recursive: true });

  const summary = {
    frozen_at: new Date().toISOString(),
    source: "production-postgres",
    company_ids: companies,
    company_count: 0,
    filings: [],
    totals: {
      filings: 0,
      sections: 0,
      policy_facts: 0,
      metric_facts: 0,
      peer_groups: 0,
      peer_group_members: 0,
      executive_comp_rows: 0,
    },
  };

  const dirtyCatalogHits = [];

  try {
    const companyRows = await sql`
      select id, cik, ticker, name, sector
      from companies
      where id = any(${companies})
      order by id
    `;
    const found = new Set(companyRows.map((c) => c.id));
    const missing = companies.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Production DB is missing fixture companies: ${missing.join(",")}`);
    }

    for (const company of companyRows) {
      const companyId = company.id;
      const companyDir = join(TMP_BY_FILING, companyId);
      mkdirSync(companyDir, { recursive: true });
      json(join(companyDir, "company.json"), mapCompany(company));
      summary.company_count++;

      const filings = await sql`
        select id, company_id, accession_number, form_type, filing_date,
               filing_year, acceptance_datetime, source_index_url,
               primary_document_url, primary_document_name, report_date
        from filings
        where company_id = ${companyId}
        order by filing_date desc, id desc
      `;

      for (const filing of filings) {
        const filingId = filing.id;
        const filingDir = join(companyDir, filingId);
        mkdirSync(filingDir, { recursive: true });

        const [
          sections,
          policies,
          metrics,
          peerGroups,
          execRows,
        ] = await Promise.all([
          sql`select * from sections where filing_id = ${filingId} order by id`,
          sql`select * from policy_facts where filing_id = ${filingId} order by id`,
          sql`select * from metric_facts where filing_id = ${filingId} order by id`,
          sql`select * from peer_groups where filing_id = ${filingId} order by id`,
          sql`select * from exec_comp_rows where filing_id = ${filingId} order by year desc, executive_name`,
        ]);

        const peerGroupIds = peerGroups.map((g) => g.id);
        const memberRows = peerGroupIds.length > 0
          ? await sql`
              select *
              from peer_group_members
              where peer_group_id = any(${peerGroupIds})
              order by peer_group_id, id
            `
          : [];
        const membersByGroup = new Map();
        for (const member of memberRows) {
          const list = membersByGroup.get(member.peer_group_id) ?? [];
          list.push(member);
          membersByGroup.set(member.peer_group_id, list);
        }

        const mappedPeerGroups = peerGroups.map((g) => {
          const members = (membersByGroup.get(g.id) ?? []).map((m) => ({
            id: m.id,
            peer_group_id: m.peer_group_id,
            company_name_raw: m.company_name_raw,
            company_id_resolved: m.company_id_resolved,
            company_name_resolved: m.company_name_resolved,
            ticker_resolved: m.ticker_resolved,
            cik_resolved: m.cik_resolved,
            resolution_confidence: toNumber(m.resolution_confidence),
          }));
          // This guard is active only while operators have populated the
          // reset-day catalog. Once the catalog is retired, the post-recovery
          // fixture-pollution test catches any future suspect-shaped row.
          const expected = KNOWN_PENDING_POLLUTION.get(companyId);
          if (expected) {
            for (const m of members) {
              if (m.ticker_resolved && expected.has(m.ticker_resolved)) {
                dirtyCatalogHits.push(
                  `${companyId}/${filingId}:${m.ticker_resolved}`,
                );
              }
            }
          }
          return {
            id: g.id,
            filing_id: g.filing_id,
            section_id: g.section_id,
            peer_group_name: g.peer_group_name,
            peer_group_type: g.peer_group_type,
            disclosed_year: g.disclosed_year,
            selection_rationale: g.selection_rationale,
            source_excerpt: g.source_excerpt,
            confidence_score: toNumber(g.confidence_score),
            ...provenance(g),
            members,
          };
        });

        const source = await maybeFetchSourceHtml(
          companyId,
          filingId,
          filing.primary_document_name,
          join(filingDir, "source.html"),
          join(BY_FILING, companyId, filingId, "source.html"),
        );

        json(join(filingDir, "filing.json"), mapFiling(filing));
        json(join(filingDir, "documents.json"), filing.primary_document_name
          ? [{
              id: `${filingId}:primary`,
              filing_id: filingId,
              sequence: null,
              document_name: filing.primary_document_name,
              document_type: filing.form_type,
              description: filing.form_type,
              is_primary: true,
              source_url: filing.primary_document_url,
              blob_url: null,
              blob_path: source.key ?? null,
              storage_path: source.key ?? null,
              mime_type: "text/html",
              sha256: source.sha,
            }]
          : []);
        json(join(filingDir, "sections.json"), sections.map(mapSection));
        json(join(filingDir, "policy_facts.json"), policies.map(mapPolicy));
        json(join(filingDir, "metric_facts.json"), metrics.map(mapMetric));
        json(join(filingDir, "peer_groups.json"), mappedPeerGroups);
        json(join(filingDir, "executive_comp.json"), execRows.map(mapExec));

        const rollup = {
          section_count: sections.length,
          policy_fact_count: policies.length,
          metric_fact_count: metrics.length,
          peer_group_count: peerGroups.length,
          peer_member_count: memberRows.length,
          executive_comp_row_count: execRows.length,
          review_status_by_artifact: {
            sections: reviewCounts(sections),
            policy_facts: reviewCounts(policies),
            metric_facts: reviewCounts(metrics),
            peer_groups: reviewCounts(peerGroups),
          },
          extractor_versions_seen: Array.from(
            new Set(
              [...sections, ...policies, ...metrics, ...peerGroups]
                .map((row) => row.extractor_version)
                .filter(Boolean),
            ),
          ).sort(),
          source_html_sha256: source.sha,
          source_html_bytes: source.bytes,
          source_html_source: source.source,
        };
        json(join(filingDir, "provenance.json"), rollup);

        summary.filings.push({
          company_id: companyId,
          filing_id: filingId,
          filing_year: filing.filing_year,
          filing_date: toDate(filing.filing_date),
          ...rollup,
        });
        summary.totals.filings++;
        summary.totals.sections += sections.length;
        summary.totals.policy_facts += policies.length;
        summary.totals.metric_facts += metrics.length;
        summary.totals.peer_groups += peerGroups.length;
        summary.totals.peer_group_members += memberRows.length;
        summary.totals.executive_comp_rows += execRows.length;

        console.log(
          `[${companyId}/${filingId}] sections=${sections.length} exec_rows=${execRows.length} peers=${peerGroups.length} policies=${policies.length} metrics=${metrics.length}`,
        );
      }
    }
  } finally {
    await sql.end();
  }

  if (dirtyCatalogHits.length > 0) {
    rmSync(TMP_BY_FILING, { recursive: true, force: true });
    console.error(
      "Refusing to freeze fixtures: production still contains cataloged suspect peer rows:\n" +
        dirtyCatalogHits.map((s) => `  - ${s}`).join("\n"),
    );
    process.exit(3);
  }

  replaceFixtureTree();
  json(join(FIXTURES, "FROZEN.json"), summary);

  console.log(
    `\nFroze ${summary.totals.filings} filings across ${summary.company_count} companies from production Postgres.`,
  );
  console.log(`Output: ${relative(process.cwd(), BY_FILING)}`);
}

main().catch((err) => {
  rmSync(TMP_BY_FILING, { recursive: true, force: true });
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
