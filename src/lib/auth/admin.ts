import { NextRequest, NextResponse } from "next/server";

/**
 * Admin token guard. Returns a 401 NextResponse if the request lacks
 * the configured PROXYMINER_ADMIN_API_TOKEN as a Bearer token, else
 * returns null so the route handler can continue.
 *
 * Same boundary as the Python admin guard. Used by ingestion routes
 * and the /review console.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.PROXYMINER_ADMIN_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "PROXYMINER_ADMIN_API_TOKEN not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided || !timingSafeEq(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
