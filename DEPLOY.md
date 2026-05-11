# Deploy runbook — ProxyMiner on Vercel

End-to-end cutover steps. Every step that requires the user's hands
is enumerated in
[`/srv/projects/ProxyMiner/ProxyMiner-Rewrite-User-Actions.md`](../ProxyMiner/ProxyMiner-Rewrite-User-Actions.md).

## 0. Prerequisites

- The Phase-0 fixtures are present at `.fixtures/by-filing/` and
  `.fixtures/FROZEN.json` reports `company_count: 12, filings: 32`.
- All tracking files at `/srv/projects/ProxyMiner/ProxyMiner-Rewrite-*.md`
  reflect the current state.

## 1. GitHub repo (A-001)

```sh
cd /srv/projects/proxyminer-vercel
git init
git checkout -b main
git add .
git commit -m "Initial scaffold — Phase 0/1/2/3/4/5/6/7/8/9 land"
git remote add origin git@github.com:arminoorata/proxyminer.git
git push -u origin main
```

## 2. Vercel project link

In the Vercel dashboard: **Add New… → Project → Import** the GitHub
repo. Framework preset: Next.js. Build settings: defaults.

## 3. Provision storage (A-002, A-003)

- **Storage → Marketplace → Neon** → name `proxyminer-db`, region
  `us-east-1`. `DATABASE_URL` is auto-injected.
- **Storage → Blob → Create** → name `proxyminer-artifacts`.
  `BLOB_READ_WRITE_TOKEN` is auto-injected.

## 4. Apply schema

```sh
npm run db:generate
npm run db:migrate
```

(Migrations land in `./drizzle/`. Drizzle-kit reads `DATABASE_URL`
from your `.env.local` if you pull it via `vercel env pull`.)

## 5. BYOK assistant (A-004 pivot)

ProxyMiner no longer needs a paid AI Gateway/provider key for Ask.
Users paste a free Google AI Studio key in the Ask panel; the browser
sends it per request as `X-Gemini-Api-Key`, and the server never stores
it.

## 6. Set non-Marketplace secrets

```sh
vercel env add PROXYMINER_SEC_USER_AGENT
# "Armi Noorata armi.noorata@gmail.com"

vercel env add PROXYMINER_ADMIN_API_TOKEN
# openssl rand -hex 32

vercel env add CRON_SECRET
# openssl rand -hex 32

vercel env add PROXYMINER_REVIEW_COOKIE_SECRET
# openssl rand -hex 32
```

## 7. Migrate the oracle data

```sh
vercel env pull .env.local
npx tsx scripts/migrate_to_postgres.ts
```

This loads the 12 companies + 32 filings from `.fixtures/` into
Neon and pushes the `source.html` artifacts to Blob. Idempotent.

## 8. Deploy

```sh
git push origin main   # auto-deploys via Vercel-GitHub integration
```

## 9. Custom domain (A-005)

In **Settings → Domains**: add `proxyminer.arminoorata.com`. Follow
Vercel's DNS instructions at your DNS host (CNAME or A — Vercel will
tell you which).

## 10. Smoke test

```sh
curl -I https://proxyminer.arminoorata.com/
curl https://proxyminer.arminoorata.com/api/search?q=clawback\&company=msft
curl -X POST https://proxyminer.arminoorata.com/api/ask \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Api-Key: $GOOGLE_AI_STUDIO_API_KEY" \
  -d '{"question":"What did the CEO get paid?","company_id":"aapl"}'
```

## 11. Decommission home server (A-007)

After 48h of healthy traffic on Vercel:

```sh
ssh homeguppie
cd /srv/projects/ProxyMiner
make app-down
sudo rm /etc/nginx/sites-enabled/proxyminer.local
sudo systemctl reload nginx
```

Keep `/srv/projects/ProxyMiner` on disk indefinitely as the migration
oracle archive.

## Rollback plan

If anything in production behaves unexpectedly:

1. **Vercel rollback:** Deployments → previous green build → **Promote
   to production**.
2. **DNS rollback:** point `proxyminer.arminoorata.com` back at the
   home server's Cloudflare Tunnel hostname (or your previous A
   record). The on-prem app is still alive until A-007 fires.
3. **Data integrity:** `.fixtures/by-filing/` is the canonical
   pre-migration snapshot; re-run `migrate_to_postgres.ts` against a
   fresh Neon if data corruption is suspected.
