/**
 * Deploy fingerprint — returns the commit SHA the running code was
 * built from. Used by CI to gate the production audit until the
 * pushed commit is actually live (Vercel deploy takes ~60s; without
 * this gate, the audit job races the deploy and can see pre-fix
 * code).
 *
 *   GET /api/version
 *   → { commit, ref, builtAt }
 *
 * Vercel injects VERCEL_GIT_COMMIT_SHA / REF automatically at build
 * time. Locally these are undefined and we fall back to "dev".
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? "dev",
      builtAt: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
    {
      headers: {
        // No caching — CI polls this until it matches.
        "cache-control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
