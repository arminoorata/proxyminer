#!/usr/bin/env node
/**
 * Peer-extractor sync readiness check (read-only, no secrets).
 *
 * The peer-extractor hardening (footnote-legend, merge completeness,
 * Merck resolution, filer-self exclusion) is a CODE fix. The committed
 * fixtures and production DB still carry the pre-fix extraction for the
 * affected tickers until they are re-ingested and refrozen. That sync is
 * OPTIONAL and an operator action.
 *
 * This script validates the ONLY safe-to-check preconditions before an
 * operator starts that sync, so nobody refreezes against pre-fix code or
 * a stale DB:
 *   1. The local worktree is at a commit (prints it).
 *   2. Production /api/version is serving that exact commit — i.e. the
 *      fix is actually deployed. Refreezing before this is true would
 *      just re-capture the pre-fix data.
 *   3. DATABASE_URL is NOT already exported in this shell — the operator
 *      should paste it inline for the freeze, not inherit a stale one.
 *   4. The affected fixtures exist locally.
 * Then it prints the exact sync steps.
 *
 * Does NOT: read DATABASE_URL's value, write the DB, refreeze fixtures,
 * dispatch a workflow, or touch any secret. Only GETs /api/version.
 *
 * Exit 0 = ready to sync (prints steps). Exit 1 = not ready (prints why).
 * Usage: npm run recovery:peer-sync-check
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE =
  process.env.PROXYMINER_BASE_URL ?? "https://proxyminer.arminoorata.com";
// Tickers whose frozen fixtures lag the hardened extractor.
const AFFECTED = ["crm", "adbe", "msft", "nflx", "qcom"];

function bold(s) {
  return `\x1b[1m${s}\x1b[22m`;
}

function localHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function prodCommit() {
  try {
    const res = await fetch(`${BASE}/api/version`, {
      headers: { "User-Agent": "proxyminer-peer-sync-check/1.0" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, commit: String(body.commit ?? body.sha ?? "") };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  console.log(bold("Peer-extractor sync readiness check (read-only)"));
  const blockers = [];

  const head = localHead();
  console.log(`  local HEAD:      ${head ?? "(not a git repo?)"}`);
  if (!head) blockers.push("could not read local HEAD");

  const prod = await prodCommit();
  if (!prod.ok) {
    console.log(`  production:      UNREACHABLE (${prod.reason})`);
    blockers.push(`production /api/version unreachable: ${prod.reason}`);
  } else {
    const live = head && prod.commit === head;
    console.log(`  production:      ${prod.commit || "(unknown)"} ${live ? "✓ deployed" : "✗ NOT serving local HEAD"}`);
    if (!live) {
      blockers.push(
        "production is not serving local HEAD yet — deploy the fix first; " +
          "refreezing now would re-capture pre-fix data",
      );
    }
  }

  // DATABASE_URL must NOT be inherited (value is never read or printed).
  if (process.env.DATABASE_URL) {
    console.log("  DATABASE_URL:    SET in this shell (✗ unset it; paste it inline for the freeze)");
    blockers.push("DATABASE_URL is already exported — unset it and provide it inline for the freeze only");
  } else {
    console.log("  DATABASE_URL:    unset ✓");
  }

  const missing = AFFECTED.filter(
    (t) => !existsSync(join(process.cwd(), ".fixtures", "by-filing", t)),
  );
  console.log(`  affected tickers: ${AFFECTED.join(", ")}${missing.length ? `  (missing fixtures: ${missing.join(", ")})` : "  ✓ present"}`);
  if (missing.length) blockers.push(`missing local fixtures for: ${missing.join(", ")}`);

  console.log("");
  if (blockers.length) {
    console.log(bold("NOT READY to sync:"));
    for (const b of blockers) console.log(`  - ${b}`);
    process.exit(1);
  }

  console.log(bold("READY. Optional production-data sync (operator action — production write):"));
  console.log(`  1. Dispatch recover-cohort.yml with tickers=${AFFECTED.join(",")} (limit 2).`);
  console.log("  2. In your shell (DATABASE_URL pasted inline, never written to a file):");
  console.log("       read -srp 'DATABASE_URL: ' DATABASE_URL; echo; export DATABASE_URL");
  console.log("       npm run verify:meta-peers          # require GAP RESOLVED (2 groups / 26 members)");
  console.log("       npm run fixtures:freeze            # only if verify passed");
  console.log("       unset DATABASE_URL");
  console.log("       npm test && npm run verify:meta-peers");
  console.log("  Never refreeze if verify shows GAP PRESENT. Never hand-edit peer_groups.json.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
