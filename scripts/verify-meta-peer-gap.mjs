#!/usr/bin/env node
/**
 * Read-only verification for the Meta 2024 peer-group gap.
 *
 * Known issue (see docs/recovery.md → "aged out of SEC recent"): the 2024
 * Meta proxy `meta/000132680124000034` (accession 0001326801-24-000034) has
 * 0 peer groups in production, while offline extraction of the same filing
 * finds 2 clean peer groups / 26 members. Root cause: this DEF 14A has aged
 * out of SEC's recent-submissions list (data.sec.gov/submissions/
 * CIK0001326801.json now lists only the 2026 and 2025 DEF 14A in
 * filings.recent). The ORIGINAL ingest read filings.recent only, so
 * recover-cohort / admin ingest could not re-reach the 2024 filing at any
 * limit. That is now fixed in code: the ingest paginates the filings.files
 * archive when recent is short (src/lib/services/sec-filing-discovery.ts).
 * Once that change is DEPLOYED to production, dispatch recover-cohort with
 * tickers=meta + limit=3, verify production exits 0, then refreeze. See
 * docs/recovery.md.
 *
 * This script PROVES whether the gap is still present, without writing
 * anything. It checks:
 *   - PRODUCTION (authoritative) when DATABASE_URL is set: counts peer_groups
 *     for the filing directly from Postgres.
 *   - FIXTURE state otherwise: counts peer rows in
 *     .fixtures/by-filing/<company>/<dir>/peer_groups.json (this is what a
 *     `fixtures:freeze` would commit; it stays empty until the filings.files
 *     ingest fix lands and the filing is re-ingested + refrozen).
 *
 * It does NOT hide a failure: when the checked source still shows 0 peer
 * groups, it prints "GAP PRESENT" and exits non-zero (1).
 *
 * Usage:
 *   npm run verify:meta-peers
 *   node scripts/verify-meta-peer-gap.mjs --company meta \
 *     --dir 000132680124000034 --accession 0001326801-24-000034
 *   DATABASE_URL=postgres://… npm run verify:meta-peers   # check production
 *
 * Exit codes: 0 = gap resolved (>= 1 peer group), 1 = gap present, 2 = error.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Defaults target the known Meta 2024 gap; overridable for other filings.
const company = arg("company", "meta").toLowerCase();
const fixtureDir = arg("dir", "000132680124000034");
const accession = arg("accession", "0001326801-24-000034");
const minGroups = Number.parseInt(arg("min-groups", "1"), 10);

// Offline-extraction baseline (from `npm run replay:extractors`): the current
// TS extractors find this much in the filing's source.html, so a successful
// re-ingest should land at roughly these counts.
const EXPECTED_BASELINE = { groups: 2, members: 26 };

function fixtureCounts() {
  const fp = join(ROOT, ".fixtures", "by-filing", company, fixtureDir, "peer_groups.json");
  if (!existsSync(fp)) {
    return { available: false, path: fp };
  }
  const groups = JSON.parse(readFileSync(fp, "utf8"));
  const members = groups.reduce((acc, g) => acc + (g.members?.length ?? 0), 0);
  return { available: true, path: fp, groups: groups.length, members };
}

async function productionCounts() {
  if (!process.env.DATABASE_URL) return { checked: false };
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const groups = await sql`
      select g.id
      from peer_groups g
      join filings f on f.id = g.filing_id
      where f.company_id = ${company}
        and f.accession_number = ${accession}
    `;
    let members = 0;
    if (groups.length > 0) {
      const ids = groups.map((g) => g.id);
      const rows = await sql`
        select count(*)::int as c
        from peer_group_members
        where peer_group_id = any(${ids})
      `;
      members = rows[0]?.c ?? 0;
    }
    return { checked: true, groups: groups.length, members };
  } finally {
    await sql.end();
  }
}

async function main() {
  console.log(`Meta peer-gap verification`);
  console.log(`  company:        ${company}`);
  console.log(`  filing:         ${fixtureDir} (accession ${accession})`);
  console.log(
    `  expected (offline baseline): ${EXPECTED_BASELINE.groups} peer groups / ${EXPECTED_BASELINE.members} members`,
  );
  console.log(`  pass threshold: >= ${minGroups} peer group(s)`);

  const fixture = fixtureCounts();
  const prod = await productionCounts();

  let source;
  let observedGroups;
  let observedMembers;

  if (prod.checked) {
    source = "production (DATABASE_URL)";
    observedGroups = prod.groups;
    observedMembers = prod.members;
    console.log(`  production:     ${prod.groups} peer groups / ${prod.members} members`);
    if (fixture.available) {
      console.log(`  fixture:        ${fixture.groups} peer groups / ${fixture.members} members (informational)`);
    }
  } else {
    source = "fixture";
    if (!fixture.available) {
      console.error(`\nERROR: fixture not found at ${fixture.path}, and DATABASE_URL is unset.`);
      process.exit(2);
    }
    observedGroups = fixture.groups;
    observedMembers = fixture.members;
    console.log(`  fixture:        ${fixture.groups} peer groups / ${fixture.members} members`);
    console.log(`  production:     not checked (set DATABASE_URL to verify the live DB directly)`);
  }

  const gapPresent = observedGroups < minGroups;
  console.log("");
  if (gapPresent) {
    console.log(
      `GAP PRESENT — ${source} shows ${observedGroups} peer group(s) for ` +
        `${company}/${fixtureDir} (need >= ${minGroups}; offline baseline is ` +
        `${EXPECTED_BASELINE.groups} groups / ${EXPECTED_BASELINE.members} members).`,
    );
    console.log("");
    console.log(`  The ${company} ${fixtureDir} DEF 14A (accession ${accession}) aged out of`);
    console.log(`  SEC's recent-submissions list. The ingest now paginates the filings.files`);
    console.log(`  archive (src/lib/services/sec-filing-discovery.ts), so this is fixable.`);
    console.log("  To close it (operator action — production write, after the fix deploys):");
    console.log(`    1. Confirm archived discovery is live (/api/version is that commit).`);
    console.log(`    2. Dispatch recover-cohort.yml with tickers=${company}, limit=3.`);
    console.log(`    3. DATABASE_URL=<prod> npm run verify:meta-peers  (require exit 0).`);
    console.log(`    4. npm run fixtures:freeze, then re-run this check (expect GAP RESOLVED).`);
    console.log(`  See docs/recovery.md ("aged out of SEC recent").`);
    process.exit(1);
  }
  console.log(
    `GAP RESOLVED — ${source} shows ${observedGroups} peer groups / ` +
      `${observedMembers} members for ${company}/${fixtureDir}.`,
  );
  if (
    observedGroups < EXPECTED_BASELINE.groups ||
    observedMembers < EXPECTED_BASELINE.members
  ) {
    console.log(
      `WARN: below the offline baseline (expected ${EXPECTED_BASELINE.groups} groups / ` +
        `${EXPECTED_BASELINE.members} members) — possible partial re-ingest; spot-check the filing.`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
