# Cohort recovery — peer-panel pollution

When the `audit-production` job in CI fails with one or more cohort
tickers flagged `FULLY-POLLUTED` or `PARTIALLY-POLLUTED`, run the
recovery workflow to re-ingest those tickers.

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

The workflow needs `PROXYMINER_ADMIN_API_TOKEN` as a **GitHub Actions
secret** in this repo. It must match the value of the same env var on
the production Vercel project (the admin ingest route compares
incoming `Authorization: Bearer …` against this token with a
timing-safe equal).

1. Pull the current value from Vercel:
   - Open https://vercel.com/arminoorata/proxyminer/settings/environment-variables
   - Find `PROXYMINER_ADMIN_API_TOKEN` (Production)
   - Copy the value
2. Add it to GitHub:
   - Go to https://github.com/arminoorata/proxyminer/settings/secrets/actions
   - Click **New repository secret**
   - Name: `PROXYMINER_ADMIN_API_TOKEN`
   - Value: paste the Vercel value
   - Save

This is a one-time step. After this the workflow can run unattended
whenever pollution recurs.

## Triggering the workflow

1. Go to https://github.com/arminoorata/proxyminer/actions/workflows/recover-cohort.yml
2. Click **Run workflow**
3. Either:
   - Leave **tickers** blank — the workflow runs the audit against
     production and re-ingests every ticker it flags.
   - Or paste a comma-separated list (lowercase), e.g. `aapl,msft,brk.b`,
     to force a specific re-ingest without the audit.
4. Click **Run workflow** again to confirm.

The workflow will:

1. Verify the admin secret is present.
2. Discover polluted tickers (from input, or by parsing the audit).
3. POST `/api/admin/ingest/<ticker>?limit=2` with bearer auth for each.
4. Re-run the full audit. If any pollution remains, the job fails.

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
| Re-ingest returns HTTP 401 | Secret value drifted from Vercel | Re-copy from Vercel into the GitHub secret |
| Re-ingest returns HTTP 503 | Vercel deploy missing the env var | Add `PROXYMINER_ADMIN_API_TOKEN` to the Vercel Production env |
| Re-audit step still finds pollution | The extractor itself is stale — re-ingesting won't fix it | Land an extractor fix, redeploy, then re-run |
| Workflow times out (>20 min) | Cohort grew or SEC rate-limited | Run with explicit `tickers` input in batches |

## Why a separate workflow

The audit lives in `ci.yml` and runs on every push to `main` and on
the weekly cron. Keeping recovery in a separate file makes the trigger
surface obvious — the audit *reads* production, the recovery workflow
*writes* to production, and they should never share a job definition
that could accidentally inherit the wrong trigger.
