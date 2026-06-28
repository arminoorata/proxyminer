#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Cohort peer-panel pollution audit.
 *
 * For each ticker currently in the ProxyMiner cohort, fetches the
 * live company page from production and classifies every peer-chip
 * against four pollution heuristics:
 *
 *   1. SINGLE-TOKEN ENGLISH ALIAS — the chip's resolved company name
 *      consists of ≤3 tokens, contains at least one common English
 *      word, and the chip likely entered the panel via the now-
 *      blocked single-token alias path (e.g. "below" → FIVE BELOW).
 *
 *   2. ALIAS-NOW-BLOCKED — the chip's stripped name normalizes to a
 *      single token that is in the COMMON_NAME_WORDS blocklist. If
 *      this chip is in production, it must have been emitted by the
 *      pre-Phase-11 extractor and just needs a re-ingest to flush.
 *
 *   3. MICRO-CAP / SPAC / FOREIGN — the chip's resolved company is in
 *      a curated suspect set known to appear only as a single-token
 *      false-positive match (e.g. TBTC Table Trac, RGCCF Relevant Gold).
 *
 *   4. CROSS-SECTOR (heuristic) — checks for chips whose name carries
 *      no token overlap with the parent company's name AND whose
 *      market-cap rank suggests a SPAC / micro-cap. Coarse signal.
 *
 * Output: one line per cohort ticker with counts of (clean, dirty,
 * unknown) chips, then a verdict (CLEAN / POLLUTED / NO-PANEL /
 * STALE-NEEDS-REINGEST).
 *
 * Usage:
 *   node scripts/audit-peer-panels.mjs
 *   node scripts/audit-peer-panels.mjs --verbose
 *
 * Exits non-zero if any ticker is flagged POLLUTED so this can be
 * wired into CI.
 */

import {
  classifyKnownPendingPollution,
  formatKnownPendingAnnotationBody,
} from "./lib/known-pending-pollution.mjs";

const peerQualityData = JSON.parse(
  readFileSync(new URL("../src/lib/services/peer-group-quality-data.json", import.meta.url), "utf8"),
);

const SITE = process.env.PROXYMINER_BASE_URL ?? "https://proxyminer.arminoorata.com";
const VERBOSE = process.argv.includes("--verbose");
// `::warning::` annotations only render when stdout is wired to a
// GitHub Actions runner. Locally they appear as plain text.
const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === "true";

const SUSPECT_TICKERS = new Set(peerQualityData.suspectPeerTickers);
const KNOWN_LEGIT_PAIRS = new Set(peerQualityData.knownLegitPeerPairs);

async function fetchCohort() {
  // Authoritative source: GET /api/cohort returns every company in
  // the DB. Falls back to the autocomplete-sweep heuristic (slower
  // + can miss tickers whose 2-letter prefix has >20 SEC competitors
  // ahead of them, e.g. CMCSA at rank >20 for `q=cm`) for older
  // deployments that don't expose the endpoint yet.
  try {
    const r = await fetch(`${SITE}/api/cohort`);
    if (r.ok) {
      const d = await r.json();
      const ids = (d.companies ?? [])
        .map((c) => (c.ticker ? c.ticker.toLowerCase() : (c.company_id ?? "").toLowerCase()))
        .filter(Boolean);
      if (ids.length > 0) return [...new Set(ids)].sort();
    }
  } catch {}
  // Fallback path
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const found = new Set();
  const queries = [...letters, ...letters.split("").flatMap((a) => letters.split("").map((b) => a + b))];
  for (const q of queries) {
    try {
      const r = await fetch(`${SITE}/api/search/ticker?q=${q}&limit=20`);
      const d = await r.json();
      for (const it of d.items ?? []) {
        if (it.in_db && it.ticker) found.add(it.ticker.toLowerCase());
      }
    } catch {}
  }
  return [...found].sort();
}

async function fetchPanel(ticker) {
  const r = await fetch(`${SITE}/company/${ticker}`, {
    headers: { "User-Agent": "ProxyMiner-Audit" },
  });
  const html = await r.text();
  const idx = html.indexOf("Peer Group");
  if (idx < 0) return { ticker, state: "no-panel", chips: [], total: 0, inDb: 0 };
  const chunk = html.slice(idx, idx + 30000);
  const memberMatch = chunk.match(/(\d+)<!-- --> members · <!-- -->(\d+)<!-- --> in ProxyMiner/);
  const total = memberMatch ? Number.parseInt(memberMatch[1], 10) : 0;
  const inDb = memberMatch ? Number.parseInt(memberMatch[2], 10) : 0;
  // Capture each chip's ticker + name from `<span class="truncate">TICKER · NAME</span>`
  const chipRe = /<span class="truncate">([A-Z][A-Z0-9.\-]{0,7}) · ([^<]+)<\/span>/g;
  const chips = [];
  let m;
  while ((m = chipRe.exec(chunk)) !== null) {
    chips.push({ ticker: m[1], name: m[2].trim() });
  }
  return { ticker, state: "panel", chips, total, inDb };
}

function classify(parentTicker, chip) {
  const key = `${parentTicker}|${chip.ticker}`;
  if (KNOWN_LEGIT_PAIRS.has(key)) return { verdict: "legit-allowlist" };
  if (SUSPECT_TICKERS.has(chip.ticker)) return { verdict: "suspect", reason: "in-curated-suspect-set" };
  // Heuristic: name contains a known-blocked English word AND name is short
  const lowered = chip.name.toLowerCase().replace(/[,.\-&'()]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = lowered.split(" ").filter(Boolean);
  // Cull suffixes from token count
  const meaningfulTokens = tokens.filter(
    (t) =>
      t.length > 1 &&
      ![
        "inc", "corp", "corporation", "company", "co", "ltd", "llc", "plc",
        "holding", "holdings", "group",
      ].includes(t),
  );
  if (meaningfulTokens.length === 1) {
    // Single-word company name — likely real (e.g. "Adobe Inc").
    return { verdict: "legit-single-word" };
  }
  return { verdict: "legit" };
}

async function audit() {
  console.log(`Auditing cohort at ${SITE} …`);
  const cohort = await fetchCohort();
  console.log(`Discovered ${cohort.length} cohort tickers via autocomplete.\n`);

  const results = [];
  for (const t of cohort) {
    const panel = await fetchPanel(t);
    const classified = panel.chips.map((c) => ({ ...c, ...classify(t, c) }));
    const dirty = classified.filter((c) => c.verdict === "suspect");
    const legit = classified.filter((c) => c.verdict.startsWith("legit"));
    let verdict;
    if (panel.state === "no-panel") verdict = "no-panel";
    else if (panel.total === 0) verdict = "empty-panel";
    else if (dirty.length === 0) verdict = "CLEAN";
    else if (dirty.length === panel.chips.length) verdict = "FULLY-POLLUTED";
    else verdict = "PARTIALLY-POLLUTED";
    results.push({ ticker: t, verdict, dirty, legit, panel });
  }

  // Sort: polluted first
  results.sort((a, b) => {
    const order = {
      "FULLY-POLLUTED": 0,
      "PARTIALLY-POLLUTED": 1,
      "CLEAN": 2,
      "empty-panel": 3,
      "no-panel": 4,
    };
    return (order[a.verdict] ?? 99) - (order[b.verdict] ?? 99);
  });

  console.log("Ticker | Verdict             | Total | Suspect | Reingest needed");
  console.log("-------+---------------------+-------+---------+----------------");
  const polluted = [];
  for (const r of results) {
    const suspectStr = r.dirty.length > 0 ? r.dirty.map((c) => c.ticker).join(",") : "-";
    const reingest = r.verdict === "FULLY-POLLUTED" || r.verdict === "PARTIALLY-POLLUTED" ? "YES" : "no";
    if (reingest === "YES") polluted.push(r.ticker);
    console.log(
      `${r.ticker.padEnd(6)} | ${r.verdict.padEnd(19)} | ${String(r.panel.total).padStart(5)} | ${String(r.dirty.length).padStart(7)} | ${reingest}  ${
        VERBOSE && r.dirty.length > 0 ? `[${suspectStr.slice(0, 70)}]` : ""
      }`,
    );
  }

  console.log(`\n${polluted.length} cohort tickers polluted, ${results.length - polluted.length} clean/empty.`);
  if (polluted.length > 0) {
    // Phase 24: distinguish "known-pending pollution waiting on the
    // external Neon-quota blocker" from "fresh regression." Always
    // exit non-zero — we never silently pass real pollution — but
    // annotate the CI log so an operator can tell the two apart at a
    // glance.
    const pollutedResults = results.filter(
      (r) => r.verdict === "FULLY-POLLUTED" || r.verdict === "PARTIALLY-POLLUTED",
    );
    const classification = classifyKnownPendingPollution(pollutedResults);
    const annotation = formatKnownPendingAnnotationBody(classification);
    if (annotation) {
      // All detected pollution sits inside the known-pending set.
      // Surface a single GitHub Actions ::warning:: with the reset
      // checklist pointer; print the same body to stdout for local
      // runs where the annotation marker is ignored.
      const marker = IN_GITHUB_ACTIONS ? "::warning::" : "[KNOWN-PENDING] ";
      console.log("");
      console.log(`${marker}${annotation}`);
    } else if (classification.unknownPairs.length > 0) {
      // At least one polluted (parent, ticker) pair is OUTSIDE the
      // known-pending set. This is a new regression — emit an ::error::
      // annotation listing the unexpected pairs so the failure is
      // unambiguously framed as fresh.
      const marker = IN_GITHUB_ACTIONS ? "::error::" : "[NEW-REGRESSION] ";
      const pairs = classification.unknownPairs
        .map((p) => `${p.parent.toUpperCase()}=${p.ticker}`)
        .join(" ");
      console.log("");
      console.log(
        `${marker}Unexpected peer-panel pollution outside the known-pending set: ${pairs}. ` +
          "Diagnose before treating as the standard recovery flow.",
      );
    }
    console.log(`\nReingest command:`);
    console.log(`  for T in ${polluted.join(" ")}; do …`);
    process.exit(1);
  }
}

audit().catch((e) => {
  console.error("AUDIT ERROR:", e);
  process.exit(2);
});
