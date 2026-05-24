#!/usr/bin/env node
/**
 * Phase 27 — reset-day verification script.
 *
 * Single read-only command that detects which step of the 2026-06-01
 * recovery sequence we're in and prints the exact next action. Safe
 * to run on any day; the output just tells you "still pre-recovery"
 * if nothing has happened yet.
 *
 * Usage:
 *   npm run recovery:reset-day-check
 *   PROXYMINER_BASE_URL=https://... node scripts/recovery-reset-day-check.mjs
 *
 * Does NOT:
 *   - Modify production DB
 *   - Modify fixtures
 *   - Trigger any workflow
 *   - Require any secret
 *
 * Detects:
 *   1. Production reachable / alive?
 *   2. Does the cohort audit run cleanly? (parses
 *      `scripts/audit-peer-panels.mjs` output)
 *   3. Is `KNOWN_PENDING_POLLUTION` still populated?
 *   4. Does the bundled fixture set still carry the catalog's
 *      suspect tickers?
 *
 * Combines those signals into one of the five lifecycle states
 * the user-facing reset-day flow distinguishes, and emits the
 * exact next-action string for the operator.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_PENDING_POLLUTION,
  isCatalogEmpty,
} from "./lib/known-pending-pollution.mjs";
import { classifyResetDayState } from "./lib/reset-day-classify.mjs";

const BASE =
  process.env.PROXYMINER_BASE_URL ?? "https://proxyminer.arminoorata.com";
const FIXTURES_ROOT = join(process.cwd(), ".fixtures", "by-filing");

function bold(s) {
  return `\x1b[1m${s}\x1b[22m`;
}
function header(s) {
  console.log(`\n${bold(s)}`);
}

// ── Probe 1: production alive ───────────────────────────────────────
async function probeAlive() {
  try {
    const res = await fetch(`${BASE}/api/version`, {
      headers: { "User-Agent": "proxyminer-reset-day-check/1.0" },
    });
    if (!res.ok) return { alive: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    return { alive: true, commit: (body.commit ?? "").slice(0, 7) };
  } catch (err) {
    return { alive: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Probe 2: cohort audit ───────────────────────────────────────────
// Spawns the existing audit script and parses its stdout. The audit
// already emits a known-pending vs new-regression annotation; we
// re-parse the table to extract the per-ticker dirty chip list so we
// can cross-reference against the catalog directly.
function runAudit() {
  if (!existsSync(join(process.cwd(), "scripts", "audit-peer-panels.mjs"))) {
    return { ok: false, reason: "scripts/audit-peer-panels.mjs missing" };
  }
  const proc = spawnSync(
    "node",
    ["scripts/audit-peer-panels.mjs", "--verbose"],
    { encoding: "utf8", env: { ...process.env, PROXYMINER_BASE_URL: BASE } },
  );
  const stdout = proc.stdout ?? "";
  // Lines look like:
  //   crm    | PARTIALLY-POLLUTED  |    10 |       5 | YES  [HEPS,KFII,TBTC,FIVE,ABVE]
  const polluted = new Map(); // parent → string[] dirty tickers
  for (const line of stdout.split("\n")) {
    const m = line.match(
      /^([a-z][a-z0-9.\-]{0,7})\s*\|\s*(FULLY-POLLUTED|PARTIALLY-POLLUTED)\s*\|\s*\d+\s*\|\s*\d+\s*\|\s*YES\s*\[([A-Z0-9,.\-]+)\]/,
    );
    if (m) {
      polluted.set(m[1], m[3].split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return {
    ok: proc.status === 0 || proc.status === 1, // 0=clean, 1=pollution
    exitCode: proc.status ?? -1,
    polluted,
    stdout,
  };
}

// ── Probe 3: catalog state ──────────────────────────────────────────
function catalogState() {
  const empty = isCatalogEmpty();
  const pairs = [];
  if (!empty) {
    for (const [parent, suspects] of KNOWN_PENDING_POLLUTION) {
      pairs.push({ parent, suspects: [...suspects].sort() });
    }
  }
  return { empty, pairs };
}

// ── Probe 4: fixture pollution state ────────────────────────────────
function fixturePollutionState(catalog) {
  if (!existsSync(FIXTURES_ROOT)) {
    return { available: false };
  }
  if (catalog.empty) {
    return { available: true, suspectsStillPresent: [] };
  }
  const stillPresent = [];
  for (const { parent, suspects } of catalog.pairs) {
    const cdir = join(FIXTURES_ROOT, parent);
    if (!existsSync(cdir)) continue;
    const seen = new Set();
    for (const filing of readdirSync(cdir).filter((f) => /^\d/.test(f))) {
      const fp = join(cdir, filing, "peer_groups.json");
      if (!existsSync(fp)) continue;
      const groups = JSON.parse(readFileSync(fp, "utf8"));
      for (const g of groups) {
        for (const m of g.members ?? []) {
          if (m.ticker_resolved) seen.add(m.ticker_resolved);
        }
      }
    }
    const matched = suspects.filter((s) => seen.has(s));
    if (matched.length > 0) {
      stillPresent.push({ parent, tickers: matched });
    }
  }
  return { available: true, suspectsStillPresent: stillPresent };
}

// ── Main ────────────────────────────────────────────────────────────
console.log(`ProxyMiner reset-day check — base ${BASE}`);

header("1. production /api/version");
const alive = await probeAlive();
console.log(
  alive.alive
    ? `   alive: commit=${alive.commit}`
    : `   UNREACHABLE: ${alive.reason}`,
);

header("2. cohort audit (read-only)");
const audit = runAudit();
if (audit.ok) {
  console.log(`   audit exit=${audit.exitCode}, polluted parents=${audit.polluted.size}`);
  for (const [parent, tickers] of audit.polluted) {
    console.log(`     ${parent}: [${tickers.join(",")}]`);
  }
} else {
  console.log(`   FAILED: ${audit.reason ?? "unknown"}`);
}

header("3. KNOWN_PENDING_POLLUTION catalog");
const catalog = catalogState();
if (catalog.empty) {
  console.log("   catalog is EMPTY (post-recovery mode)");
} else {
  for (const { parent, suspects } of catalog.pairs) {
    console.log(`   ${parent.toUpperCase()}: [${suspects.join(",")}]`);
  }
}

header("4. .fixtures/by-filing peer rows");
const fixtures = fixturePollutionState(catalog);
if (!fixtures.available) {
  console.log("   .fixtures/by-filing not present in this checkout");
} else if (catalog.empty) {
  console.log("   (skipped — catalog already retired)");
} else if (fixtures.suspectsStillPresent.length === 0) {
  console.log("   no catalog suspects observed in fixtures (fresh refreeze)");
} else {
  for (const { parent, tickers } of fixtures.suspectsStillPresent) {
    console.log(`   ${parent.toUpperCase()}: [${tickers.join(",")}]`);
  }
}

header("Verdict");
const verdict = classifyResetDayState(
  { alive, audit, catalog, fixtures },
  { baseUrl: BASE },
);
console.log(`   STATE: ${bold(verdict.label)}`);
console.log(`   NEXT:  ${verdict.next}`);
console.log("");

// Exit 0 = informational. Always. This is a status reporter, not a
// CI gate. The operator decides what to do with the verdict.
process.exit(0);
