# Cohort recovery — peer-panel pollution

When the `audit-production` job in CI fails with one or more cohort
tickers flagged `FULLY-POLLUTED` or `PARTIALLY-POLLUTED`, run one of
the two recovery workflows:

| Workflow | When to use | Touches | External dependencies |
|---|---|---|---|
| [`recover-peer-pollution.yml`](../.github/workflows/recover-peer-pollution.yml) (DB-only, Phase 21) | The extractor fix is already deployed and the pollution is stale rows from a previous ingest. Skips SEC entirely. | `peer_group_members` rows only | **Healthy Neon/Postgres quota.** No SEC, no Blob, no outbound fetch — but every dry-run and delete still runs Postgres `SELECT` / `DELETE`. If Neon is quota-frozen, this workflow fails at `phase: resolve_parents`. |
| [`recover-cohort.yml`](../.github/workflows/recover-cohort.yml) (full re-ingest, Phase 18) | New filings or first-time imports — when the row needs to be rebuilt from SEC. | `peer_groups`, `filings`, `companies` | Healthy Neon/Postgres quota **and** Vercel outbound data-transfer quota for SEC fetches. |

In practice today: **start with `recover-peer-pollution.yml`** unless
you need to import a brand-new filing — *and* confirm Neon quota is
healthy first (see the failure-mode table below).

## Current production blocker (as of 2026-05-23)

Production Neon project is on the **Free tier** and has exhausted its
monthly data-transfer quota. The recovery dry-run reaches
`/api/admin/recover/peer-pollution`, authenticates successfully, and
then fails at the first `SELECT` against `companies` with:

```json
{
  "error": "recover_query_failed",
  "phase": "resolve_parents",
  "pg_code": "XX000",
  "message": "... data transfer quota ..."
}
```

`XX000` is Postgres's internal `internal_error` SQLSTATE. Neon
surfaces quota exhaustion through that code with a message that
mentions "data transfer quota". The recovery workflow cannot proceed
under this condition; no retry will succeed until the Neon quota
resets.

**Recovery is gated on Neon quota reset (expected 2026-06-01).** Do
not rotate the admin token, redeploy, or rerun the recovery workflow
in response to this failure — none of those address the quota.

See the [June 1 reset checklist](#june-1-reset-checklist) below.

## What "pollution" means here

A cohort company's Peer Group panel contains chips matched via the
old single-token alias path (for example, "below" resolving to FIVE
BELOW). These rows are stale — the current extractor blocks them, but
existing DB rows survive until that company is re-ingested. The
[`scripts/audit-peer-panels.mjs`](../scripts/audit-peer-panels.mjs)
script walks every cohort company on production and flags any peer
chip that matches a curated suspect set or single-token blocklist.

## When to trigger recovery

Trigger the workflow when **either** is true:

- The `audit cohort peer panels` job in [CI](../.github/workflows/ci.yml)
  fails on `main` or on the weekly schedule.
- You have a specific list of tickers that need a forced re-ingest
  (skip the audit and pass them as input).

## One-time setup

Both workflows need `PROXYMINER_ADMIN_API_TOKEN` as a **GitHub Actions
secret** in this repo. It must match the value of the same env var on
the production Vercel project (the admin routes compare incoming
`Authorization: Bearer …` against this token with a timing-safe equal).

### If the existing Vercel token is retrievable

1. Open https://vercel.com/arminoorata-3948s-projects/proxyminer/settings/environment-variables
2. Click the row for `PROXYMINER_ADMIN_API_TOKEN` (Production)
3. Reveal / copy the value
4. Add it to GitHub:
   - Go to https://github.com/arminoorata/proxyminer/settings/secrets/actions
   - Click **New repository secret**
   - Name: `PROXYMINER_ADMIN_API_TOKEN`
   - Value: paste the Vercel value
   - Save

### If the existing Vercel token is marked Sensitive and cannot be revealed

Vercel can mark env vars as "Sensitive" which makes them
non-retrievable via the UI or CLI — only the runtime function can
read them. In that case **rotate the token**:

1. Generate a new strong value (recommended: 32+ chars,
   alphanumeric — `openssl rand -hex 32` or `python3 -c "import
   secrets; print(secrets.token_urlsafe(32))"`).
2. In Vercel, edit `PROXYMINER_ADMIN_API_TOKEN` and paste the new
   value (or delete + re-add). Save.
3. **Redeploy** so the production function reads the new value:
   - Either push any commit to `main` (CI handles it), or
   - In Vercel dashboard → Deployments → ⋯ → Redeploy on the latest
     production deployment.
4. Add the same value to the GitHub repo secret per the steps above.
5. Verify both sides agree by triggering
   `recover-peer-pollution.yml` — the workflow's first step fails
   loudly if the secret is missing, and any HTTP 401 from
   `/api/admin/recover/peer-pollution` indicates token mismatch.

This is a one-time step. After this the workflow can run unattended
whenever pollution recurs.

## Triggering recover-peer-pollution (DB-only, no SEC fetch)

Use this for the most common case: stale rows from before an
extractor fix landed. Today's known pollution (CRM/NFLX/QCOM with
HEPS/KFII/TBTC/FIVE/ABVE/SFWJ chips) is exactly this case.

1. Go to https://github.com/arminoorata/proxyminer/actions/workflows/recover-peer-pollution.yml
2. Click **Run workflow**
3. Either:
   - Leave the defaults — targets `parents=crm,nflx,qcom` and
     `suspects=HEPS,KFII,TBTC,FIVE,ABVE,SFWJ`.
   - Or paste different values: lowercase parent tickers,
     UPPERCASE suspect tickers.
4. Click **Run workflow** again to confirm.

The workflow will:

1. Verify the admin secret is present.
2. Run the driver's offline self-tests (safety-gate + chip-regex + idempotency contracts).
3. POST `/api/admin/recover/peer-pollution` with `confirm: false`.
4. Apply safety gates:
   - HTTP 200 + `dry_run: true`
   - every resolved parent is in the requested parent list
   - every row's `company_id` matches a requested parent
   - every row's `ticker_resolved` matches a requested suspect
   - `rows_affected ≤ 25` (cap; 0 short-circuits to step 6)
5. Only if all gates pass and `rows_affected > 0`, POST again with `confirm: true`.
6. Run the full cohort audit + smoke-check `/company/<parent>` and
   `/api/search/ticker?q=nvidia`. The smoke check uses an HTML parser
   on the company pages — not JSON — and asserts none of the suspect
   tickers appear as peer chips. Fail loudly if anything regressed.

### Idempotent — safe to rerun

If a previous run completed the delete but failed during smoke
(e.g. transient network or cache lag), rerun the workflow with the
same inputs. The dry-run will now return `rows_affected: 0`, the
driver short-circuits to step 6, and the workflow exits green if
production is clean. **No safety-gate failure on zero rows.**

## Triggering recover-cohort (full SEC re-ingest)

Use this when you need to rebuild a peer panel from a fresh SEC
fetch — new filing, missing data, or wholesale reset. **Requires
Vercel egress quota to be available**; if outbound SEC fetches are
blocked the workflow will fail with HTTP 503 / quota errors.

1. Go to https://github.com/arminoorata/proxyminer/actions/workflows/recover-cohort.yml
2. Click **Run workflow**
3. Either:
   - Leave **tickers** blank — the workflow runs the audit against
     production and re-ingests every ticker it flags.
   - Or paste a comma-separated list (lowercase), e.g. `aapl,msft,brk.b`,
     to force a specific re-ingest without the audit.
4. Click **Run workflow** again to confirm.

## Safety properties

- **No PR triggers.** The workflow is `workflow_dispatch` only. A
  fork or untrusted PR cannot reach the production admin endpoint
  through this file.
- **Bearer token never logged.** The secret is exposed only as an env
  var, and curl reads it via `-H "Authorization: Bearer $TOKEN"`.
  GitHub masks any echo of a known secret.
- **Idempotent.** Re-ingesting a company that's already clean is a
  no-op from the audit's perspective — the workflow will simply find
  zero dirty tickers on the second pass and exit green.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Step "Verify admin token secret" fails | Secret not yet added in repo settings | Do the one-time setup above |
| Recovery returns HTTP 401 | Secret value drifted from Vercel | Re-copy from Vercel into the GitHub secret OR rotate per the "marked Sensitive" path |
| Recovery returns HTTP 503 | Vercel deploy missing the env var, or DATABASE_URL not configured | Add `PROXYMINER_ADMIN_API_TOKEN` (or DB URL) to the Vercel Production env, then redeploy |
| Recovery returns HTTP 500 with `error: "recover_query_failed"`, `phase: "resolve_parents"`, `pg_code: "XX000"` and a message mentioning "data transfer quota" | **Neon Postgres data-transfer quota exhausted** (Free tier). The route auth + input validation passed; Drizzle could not run `SELECT ... FROM companies`. | Wait for the next Neon monthly reset (currently expected 2026-06-01), then rerun. Do **not** rotate the admin token, redeploy Vercel, or retry repeatedly — none of those help. |
| Recovery returns HTTP 500 with `error: "recover_query_failed"` and any other `phase` | Drizzle threw on a specific query. The `pg_code` + `message` are surfaced in the response (Phase 23). | Fix the underlying schema/data drift named by the response. |
| Safety gate `unexpected_scope` | Dry-run found more affected rows than the cap (default 25) | Inspect the dry-run output — either narrow `parents`/`suspects` or raise `MAX_ROWS` in `.github/workflows/scripts/recover_peer_pollution.py` |
| Re-audit step still finds pollution | A different suspect ticker is in the panel (not in the suspects list) | Re-run the audit locally with `--verbose` to see the chip names, then run the workflow again with an expanded `suspects` input |
| Re-ingest returns "data transfer quota exceeded" (recover-cohort only) | Vercel egress quota tripped on SEC fetches | Either wait for monthly reset / upgrade plan, OR use the DB-only `recover-peer-pollution.yml` workflow which doesn't fetch SEC (but still requires Neon quota — see row above) |

## June 1 reset checklist

When Neon's monthly data-transfer quota resets (expected 2026-06-01),
the production blocker clears and the recovery sequence below can
complete. Run the steps in order. Each step has a verification
signal; do not advance until the signal is observed.

Before starting, run the state probe to confirm you're really in
the pre-recovery state:

```bash
npm run recovery:reset-day-check
```

Expected initial verdict: **`PRE-RECOVERY`**. If you see anything
else (`FRESH-REGRESSION`, `RECOVERY-DONE-FIXTURES-STALE`,
`FIXTURES-FRESH-CATALOG-STALE`, `FULLY-CLEAN`), follow the printed
next-action — the standard recovery path may not be what you want.

### Step 1 — Trigger production recovery

Open
<https://github.com/arminoorata/proxyminer/actions/workflows/recover-peer-pollution.yml>
→ **Run workflow** → leave defaults (`parents=crm,nflx,qcom`,
`suspects=HEPS,KFII,TBTC,FIVE,ABVE,SFWJ`) → click the green **Run
workflow** button.

**Signal it worked:** the run completes green. The driver prints
`Recovery complete. Production audit is clean.` Successful means
dry-run → confirmed delete → audit + smoke all passed.

**If it fails with `phase: resolve_parents` / `pg_code: XX000`:**
Neon's data-transfer quota has not actually reset yet. Re-run the
state probe; it will report `PRE-RECOVERY` again. Wait and retry.

### Step 2 — Verify production audit is clean

From the project root:

```bash
node scripts/audit-peer-panels.mjs --verbose
```

**Signal it worked:** all cohort tickers show `CLEAN` or
`no-panel`. The script exits 0. No `PARTIALLY-POLLUTED` or
`FULLY-POLLUTED` rows. The known-pending `::warning::` annotation
no longer fires.

### Step 3 — Rerun the failing CI audit job

Find the most recent failed `CI / audit cohort peer panels` run on
`main` at
<https://github.com/arminoorata/proxyminer/actions/workflows/ci.yml>
and rerun just the failed job.

**Signal it worked:** the rerun goes green. The Phase 24 known-
pending annotation no longer shows up.

### Step 4 — Re-ingest the cohort and refreeze fixtures

Production now has clean peer-group rows for CRM/NFLX/QCOM, but
the bundled `.fixtures/by-filing/` still carries the old Phase
11-era output and the current extractor's improvements
(see Phase 26 replay; every filing reports `policy +1` /
`metric +2` deltas).

Re-ingest the cohort so production carries the current extractor's
output, then refreeze fixtures from production:

```bash
# (1) For each cohort ticker, run admin re-ingest or trigger
#     `recover-cohort.yml` with the cohort list. SEC fetches now
#     consume Vercel egress quota — chunk this if needed.
# (2) Once production has the current extractor's output:
npm run fixtures:freeze
```

**Signal it worked:** `npm run recovery:reset-day-check` now
reports **`FIXTURES-FRESH-CATALOG-STALE`**. The audit is clean
AND the fixture peer rows no longer carry the catalog suspects.

### Step 5 — Retire the `KNOWN_PENDING_POLLUTION` catalog

Open
[`scripts/lib/known-pending-pollution.mjs`](../scripts/lib/known-pending-pollution.mjs)
and replace the `KNOWN_PENDING_POLLUTION` Map with `new Map()`.
Leave the lifecycle docstring in place — future operators may need
the same playbook.

**Signal it worked:** `src/lib/data/fixture-pollution.test.ts`
automatically switches into POST-RECOVERY mode (any suspect ticker
in fixtures now flags as a fresh regression). The Phase 24 audit
annotation falls back to plain `::error::` framing on any future
pollution.

### Step 6 — Final smoke

```bash
npm run smoke:quota-freeze
npm test
npm run recovery:reset-day-check
```

**Signal it worked:** the smoke is 11/11, vitest passes, and the
reset-day check reports **`FULLY-CLEAN`**. Recovery is complete.

If any step fails after the reset, the failure is no longer
quota-shaped — diagnose with the Phase 23 structured-error fields
(`error`, `phase`, `pg_code`, `message`) from the workflow log and
the verdict from `npm run recovery:reset-day-check`.

## Why a separate workflow

The audit lives in `ci.yml` and runs on every push to `main` and on
the weekly cron. Keeping recovery in a separate file makes the trigger
surface obvious — the audit *reads* production, the recovery workflow
*writes* to production, and they should never share a job definition
that could accidentally inherit the wrong trigger.
