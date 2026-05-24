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

```
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

```
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
