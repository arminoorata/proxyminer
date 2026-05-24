#!/usr/bin/env node
/**
 * Phase 25 — public-read smoke check under Neon quota freeze.
 *
 * Hits every public read surface that should keep working when the
 * Postgres backend is quota-frozen, and asserts each one returns a
 * 200 with the expected shape. Does NOT touch any admin / write /
 * ingest path — those are EXPECTED to fail under quota and the
 * smoke check would mask that.
 *
 * Usage:
 *   node scripts/smoke-quota-freeze.mjs                              # against production
 *   node scripts/smoke-quota-freeze.mjs http://localhost:3000        # against local dev
 *   PROXYMINER_BASE_URL=https://... node scripts/smoke-quota-freeze.mjs
 *
 * Exit code:
 *   0 — every probe returned 200 with non-empty content
 *   1 — at least one probe failed; details printed to stderr
 *
 * What this proves: public-read resilience. The fixture fallback in
 * src/lib/data/source.ts keeps these surfaces serving content even
 * when the live Postgres backend cannot respond. If any of these
 * probes fail while Neon is unhealthy, that's a regression in the
 * fallback path.
 */

const BASE =
  process.argv[2] ??
  process.env.PROXYMINER_BASE_URL ??
  "https://proxyminer.arminoorata.com";

const probes = [
  {
    name: "GET / (homepage)",
    url: "/",
    check: (text) =>
      text.includes("ProxyMiner") && text.includes("What did they pay them"),
  },
  {
    name: "GET /api/version",
    url: "/api/version",
    json: true,
    check: (data) => typeof data.commit === "string" && data.commit.length > 0,
  },
  {
    name: "GET /api/cohort",
    url: "/api/cohort",
    json: true,
    check: (data) => Array.isArray(data.companies) && data.companies.length > 0,
  },
  {
    name: "GET /api/search/ticker?q=nvidia (in-db hit)",
    url: "/api/search/ticker?q=nvidia&limit=3",
    json: true,
    check: (data) => {
      const items = data.items ?? [];
      return items.some((it) => it.ticker === "NVDA" && it.in_db === true);
    },
  },
  {
    name: "GET /api/search/ticker?q=appf (not-in-db hit)",
    url: "/api/search/ticker?q=appf&limit=3",
    json: true,
    check: (data) => {
      // Either appf surfaces (live SEC universe) or the search comes
      // back degraded with bundled fallback. Both shapes are valid
      // — just assert we got items OR an explicit degraded marker.
      const items = data.items ?? [];
      return items.length > 0 || data.degraded === true;
    },
  },
  {
    name: "GET /company/aapl",
    url: "/company/aapl",
    check: (text) =>
      text.includes("Apple") || text.includes("AAPL"),
  },
  {
    name: "GET /company/crm",
    url: "/company/crm",
    check: (text) => text.length > 1000 && text.includes("Peer Group"),
  },
  {
    name: "GET /compare",
    url: "/compare",
    check: (text) => text.includes("Compare") || text.includes("ProxyMiner"),
  },
  {
    name: "GET /glossary (static)",
    url: "/glossary",
    check: (text) => text.length > 500,
  },
  {
    name: "GET /guide (static)",
    url: "/guide",
    check: (text) => text.length > 500,
  },
  {
    name: "GET /legal (static)",
    url: "/legal",
    check: (text) => text.length > 500,
  },
];

let failed = 0;
let passed = 0;

for (const p of probes) {
  process.stdout.write(`  ${p.name.padEnd(55)} `);
  try {
    const res = await fetch(`${BASE}${p.url}`, {
      headers: { "User-Agent": "proxyminer-smoke-quota-freeze/1.0" },
    });
    if (res.status !== 200) {
      failed++;
      console.log(`FAIL (HTTP ${res.status})`);
      console.error(
        `    expected 200, got ${res.status} from ${BASE}${p.url}`,
      );
      continue;
    }
    const body = p.json ? await res.json() : await res.text();
    const ok = p.check(body);
    if (ok) {
      passed++;
      console.log("ok");
    } else {
      failed++;
      console.log("FAIL (content check)");
      console.error(
        `    check returned false for ${BASE}${p.url} ` +
          `(first 200 chars: ${
            typeof body === "string"
              ? body.slice(0, 200)
              : JSON.stringify(body).slice(0, 200)
          })`,
      );
    }
  } catch (err) {
    failed++;
    console.log("FAIL (fetch error)");
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("");
console.log(`Quota-freeze smoke: ${passed}/${probes.length} ok against ${BASE}`);
if (failed > 0) {
  console.error(`${failed} probe(s) failed — fallback path may have regressed.`);
  process.exit(1);
}
