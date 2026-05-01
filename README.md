# ProxyMiner — Vercel + AI rewrite

Source-grounded executive compensation research. Sibling tool to
`fair.arminoorata.com`, `signs.arminoorata.com`, `flsa.arminoorata.com`.
Deploys to `proxyminer.arminoorata.com` once the user actions in
`/srv/projects/ProxyMiner/ProxyMiner-Rewrite-User-Actions.md` are done.

## What's in this repo

```
src/
  app/                 — Next.js App Router pages + route handlers
    api/ask            — grounded AI assistant (AI SDK + Gateway)
    api/admin/ingest   — admin ingestion route
    api/cron/          — Vercel Cron handlers
    api/search         — source search
    company/[id]       — company workspace
    review/            — internal review console
  components/          — sibling-pattern chrome (header, footer, nav, theme)
  lib/
    ai/                — citation schema, grounded prompts, gateway client
    blob/              — Vercel Blob adapter (with local fallback)
    data/              — fixture-backed read API for dev mode
    db/                — Drizzle schema + Neon Postgres client
    extractors/        — TS ports of the Python extractor pipeline
    parity/            — JSON canonicalization + fixture diff harness
    services/          — orchestration (ingest, etc.)
    types.ts           — shared domain types
.fixtures/             — Phase-0 oracle (Python output snapshots)
scripts/               — Phase-0/9 fixture freeze + migration
```

## Local dev (no cloud creds needed)

```sh
npm install
npm run dev     # serves on :3000 against the .fixtures/ tree
```

Without `DATABASE_URL` the app reads the Phase-0 fixtures directly,
so you get a working company page (AAPL, MSFT, etc.) immediately.
The AI route returns a refusal until `AI_GATEWAY_API_KEY` is set.

## Tests

```sh
npm test
```

Includes:
- `src/lib/parity/canonical.test.ts` — canonical-JSON / canonical-text
- `src/lib/parity/comparator.test.ts` — diff harness
- `src/lib/extractors/executive-comp.parity.test.ts` — TS extractor vs
  Python oracle (32 filings)

## Pre-deploy checklist

See `/srv/projects/ProxyMiner/ProxyMiner-Rewrite-User-Actions.md` for
the exact steps. Summary:

1. Create the GitHub repo (A-001)
2. Provision Neon Postgres (A-002)
3. Provision Vercel Blob (A-003)
4. Enable Vercel AI Gateway (A-004)
5. Attach `proxyminer.arminoorata.com` (A-005)
6. Run `npx tsx scripts/migrate_to_postgres.ts` once
7. Decommission home server (A-007)

## Sibling pattern

This repo follows `/srv/projects/SIBLING_TOOL_PATTERN.md` verbatim:
Gilt palette tokens, Outfit + JetBrains Mono, dark-default theme with
the sun/moon toggle, eyebrow brand "ProxyMiner Toolkit", 9-dot nav
menu, attribution footer, italic disclaimer block.

## Why this rewrite exists

The on-prem Python/FastAPI implementation at `/srv/projects/ProxyMiner`
is the migration oracle, not the long-term runtime. See
`/srv/projects/ProxyMiner/ProxyMiner-Vercel-AI-Rewrite-Plan.md`.
