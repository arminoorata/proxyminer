import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const expected = process.env.PROXYMINER_ADMIN_API_TOKEN;
  const secret = process.env.PROXYMINER_REVIEW_COOKIE_SECRET;

  if (!expected || !secret) {
    return NextResponse.redirect(
      new URL("/review/login?error=Reviewer+config+missing", req.url),
    );
  }
  if (!sameToken(token, expected)) {
    return NextResponse.redirect(
      new URL("/review/login?error=Invalid+token", req.url),
    );
  }

  const issued = String(Date.now());
  const sig = createHmac("sha256", secret).update(issued).digest("hex");
  const value = `${issued}.${sig}`;

  const store = await cookies();
  store.set({
    name: "proxyminer_review",
    value,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/review",
    maxAge: 60 * 60 * 8,
  });

  return NextResponse.redirect(new URL("/review", req.url));
}

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
