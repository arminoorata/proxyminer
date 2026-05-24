# Operating ProxyMiner under a Neon quota freeze

ProxyMiner uses Neon Postgres on the Free tier. The Free tier meters
total monthly data transfer; when the meter ticks over, every
outbound `SELECT` / `INSERT` / `UPDATE` / `DELETE` against the project
returns `SQLSTATE XX000` with a "data transfer quota exceeded"
message until the next monthly reset.

This doc describes how the app behaves during that freeze, what
operators should and should NOT do, and what to verify when the
quota resets. The companion doc
[`recovery.md`](./recovery.md#june-1-reset-checklist) covers the
post-reset cleanup steps; this one is purely about the freeze window.

## What still works (public read paths)

Every public-facing read surface routes through `src/lib/data/source.ts`,
which catches any Postgres throw and falls back to the bundled
fixtures under `.fixtures/by-filing/`. The fixtures cover all 12
cohort companies (AAPL, ADBE, AMZN, AVGO, CRM, GOOGL, META, MSFT,
NFLX, NVDA, ORCL, QCOM) with full executive comp, peer-group, and
section data — so all of the following keep serving:

| Surface | Backed by |
|---|---|
| `/` (homepage) | `listCompanies()` |
| `/company/[id]` | `getCompany` + `listFilings` + `getLatestFiling` + `getFilingDetail` |
| `/company/[id]/diff` | same |
| `/compare` | same, in batch |
| `/api/cohort` | `listCompanies()` |
| `/api/search` | `listCompanies` + `listFilings` + `getFilingDetail` (FTS path skipped under fixture mode) |
| `/api/search/ticker` | `listCompanies()` + bundled `.fixtures/ticker_map.json` for the SEC universe |
| `/api/peerset/export` | per-company `getCompany` + `getLatestFiling` with per-company try/catch |
| `/api/company/[id]/export.pdf` | same data path as `/company/[id]` |
| `/api/ask` | reads via `source.ts`; the optional `ask_interactions` audit insert is wrapped so a write failure doesn't break the answer |
| `/glossary`, `/guide`, `/legal` | static, no DB |
| `/api/version` | static SHA, no DB |

These are verified end-to-end by [`scripts/smoke-quota-freeze.mjs`](../scripts/smoke-quota-freeze.mjs):

```bash
node scripts/smoke-quota-freeze.mjs                          # vs production
node scripts/smoke-quota-freeze.mjs http://localhost:3000    # vs local dev
```

The script exits non-zero if any probe returns non-200 or fails its
content check.

## What is INTENTIONALLY broken (and should stay that way)

The following all require a live, writable Postgres. They do **not**
have a fixture fallback by design — silently writing to a fake
backend would be more dangerous than failing visibly.

| Surface | Failure shape under quota |
|---|---|
| `POST /api/admin/recover/peer-pollution` | `recover_query_failed` / `phase: resolve_parents` / `pg_code: XX000` |
| `POST /api/admin/ingest/[identifier]` | bubbles up the Postgres error |
| `POST /api/admin/reextract-sections` | bubbles up the Postgres error |
| `POST /api/admin/reextract-facts` | bubbles up the Postgres error |
| `POST /api/admin/seed-from-fixtures` | bubbles up the Postgres error |
| `POST /api/admin/migrate` | bubbles up the Postgres error |
| `POST /api/ingest/public/[ticker]` | the worker's SEC fetch already costs Vercel egress; a Postgres write failure surfaces via the `ingest_jobs` row as `status: failed` with an `error_code` |
| `recover-peer-pollution.yml` GitHub Actions workflow | exits non-zero with the structured error above |
| `recover-cohort.yml` GitHub Actions workflow | same |
| `CI / audit cohort peer panels` | exits non-zero because production still serves polluted peer rows from fixtures (which were frozen before the Phase 11 / 11.5 / 16 extractor fixes) |

## What NOT to do during a freeze

- **Don't rotate the admin token.** Every quota-shaped 500 has nothing
  to do with auth. Rotation triggers a Vercel redeploy that won't
  change anything Postgres can see.
- **Don't redeploy "to refresh the connection."** Postgres connections
  are short-lived and recreated per request; the freeze is account-
  scoped, not connection-scoped.
- **Don't run `recover-peer-pollution.yml` repeatedly.** Every attempt
  burns Vercel function minutes for the same `phase: resolve_parents`
  failure and accomplishes nothing.
- **Don't add fallback to admin/write routes** in a panic. The whole
  point is that they fail loudly. Silent fallback would corrupt audit
  trails.

## What to expect from CI

The `CI / audit cohort peer panels` job will continue to fail on every
push to `main` while production still has the stale CRM/NFLX/QCOM
pollution. Phase 24 added a GitHub Actions `::warning::` annotation
to that job so the failure shows up framed as:

```text
[KNOWN-PENDING] Neon Free data-transfer quota exhausted; DB-only recovery
blocked until reset. Detected pollution matches the known-pending set
exactly: CRM=[…] NFLX=[…] QCOM=[…]. Next eligible recovery date:
2026-06-01. […] This CI failure does NOT indicate a fresh regression.
```

If the annotation flips to `::error::` with "Unexpected peer-panel
pollution outside the known-pending set", that IS a fresh regression
and needs separate diagnosis — the catalog
[`scripts/lib/known-pending-pollution.mjs`](../scripts/lib/known-pending-pollution.mjs)
needs updating only after the underlying root cause is understood,
not before.

The `lint + test + build` job is independent of production and stays
green throughout the freeze.

## What to verify after the quota resets

See [`recovery.md`](./recovery.md#june-1-reset-checklist) — the four-
step checklist that runs the recovery workflow, audits the cohort,
reruns the failed CI job, and smokes the homepage degraded UX.

## Offline tools for use during the freeze

The freeze window is a good time to look at data quality without
touching production. Two read-only tools were added in Phase 26.

### `npm run replay:extractors`

Runs the **current** extractors against every `source.html` checked
into `.fixtures/by-filing/` and compares per-filing counts against
the frozen JSON outputs (executive_comp.json, policy_facts.json,
metric_facts.json, peer_groups.json) sitting next to each.

Reports one line per filing showing the count deltas:

```text
crm/000110852425000009: exec 15(·)  policy 8(+1)  metric 7(+2)  peers 0(-1)  members 0(-12) [noise-suppressed]
```

Where:

- **`+N`** on `policy` / `metric` / `exec` means the current
  extractor produces N more facts than the frozen fixture. These
  are improvements that have shipped in code but aren't visible
  to users until the underlying filing is re-ingested.
- **`[noise-suppressed]`** on `peers` means the current extractor
  correctly drops a peer-group row that the frozen fixture
  carried as noise — e.g. the polluted Phase 11 era output that
  the recovery workflow targets.
- `exec` / `policy` / `metric` counts MUST not regress; the test
  fails if they do. `peers` is allowed to drop because noise
  suppression is the intended behavior.

This is gated behind `EXTRACTOR_REPLAY=1` and `.fixtures/by-filing/`
must exist locally. CI skips it because the raw `source.html` files
are gitignored.

### Fixture-pollution assertion test

`src/lib/data/fixture-pollution.test.ts` runs unconditionally during
`npm test` and pins the current fixture peer-pollution shape against
`scripts/lib/known-pending-pollution.mjs`. Two assertions:

1. Every `(parent, suspect)` pair listed in `KNOWN_PENDING_POLLUTION`
   IS present in the corresponding parent's fixture peer rows. If
   this fails, the fixtures were refrozen without first running the
   2026-06-01 production recovery — CI would have looked green while
   production was still dirty.
2. No NEW suspect-shaped ticker has drifted into a known-pending
   parent's fixture rows. Drift means catalog out of date.

The companion `KNOWN_PENDING_POLLUTION` catalog is the single source
of truth for "expected pending pollution" and is shared with
`scripts/audit-peer-panels.mjs` so the CI annotation, the fixture
test, and the operator-facing docs all agree on the same set.

### Do NOT refreeze fixtures before the recovery runs

`npm run fixtures:freeze` is intentionally NOT a Phase 26 deliverable.
Refreezing while the production DB still carries the
Phase 11-era pollution would produce clean fixtures that mask a
still-dirty production DB the moment a request falls through to the
fixture path. The correct ordering is:

1. Neon quota resets (expected 2026-06-01).
2. Run `recover-peer-pollution.yml` to clean the production DB.
3. Re-ingest the cohort so production carries the current extractor's
   output.
4. THEN run `npm run fixtures:freeze` to refresh the bundled
   fallback set.

The fixture-pollution test guards this ordering.
