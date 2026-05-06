/**
 * Review-state mutation endpoint. Accepts a form POST from the review
 * console with artifact_type / artifact_id / action / note, validates
 * the cookie, then writes review_status + review_notes via Drizzle.
 *
 * In fixture mode it returns 200 without persisting (the fixture tree
 * is read-only).
 */
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";

import { fixtureMode } from "@/lib/data/fixture-source";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = cookieStore.get("proxyminer_review");
  if (!session || !validSession(session.value)) {
    return NextResponse.redirect(new URL("/review/login", req.url));
  }

  const form = await req.formData();
  const artifact_type = String(form.get("artifact_type") ?? "");
  const artifact_id = String(form.get("artifact_id") ?? "");
  const action = String(form.get("action") ?? "");
  const note = String(form.get("note") ?? "") || null;

  if (!artifact_type || !artifact_id || !["reviewed", "flagged", "unreviewed"].includes(action)) {
    return NextResponse.redirect(new URL("/review", req.url));
  }

  if (fixtureMode()) {
    // Fixture tree is read-only — surface the action in a redirect param.
    return NextResponse.redirect(
      new URL(`/review?ack=${encodeURIComponent(`${artifact_type}/${artifact_id}/${action}`)}`, req.url),
    );
  }

  const { db, schema } = await import("@/lib/db/client");
  const id = Number.parseInt(artifact_id, 10);
  const tableMap: Record<string, typeof schema.sections | typeof schema.policy_facts | typeof schema.metric_facts | typeof schema.peer_groups> = {
    section: schema.sections,
    policy_fact: schema.policy_facts,
    metric_fact: schema.metric_facts,
    peer_group: schema.peer_groups,
  };
  const table = tableMap[artifact_type];
  if (!table) {
    return NextResponse.redirect(new URL("/review", req.url));
  }
  const idColumn = (table as typeof schema.sections).id;
  await db()
    .update(table)
    .set({
      review_status: action as "reviewed" | "flagged" | "unreviewed",
      review_notes: note,
      reviewed_by: "console",
      reviewed_at: new Date(),
      verification_status:
        action === "reviewed"
          ? "verified"
          : action === "flagged"
            ? "rejected"
            : "machine_extracted",
    })
    .where(eq(idColumn, id));

  return NextResponse.redirect(new URL("/review", req.url));
}

function validSession(value: string): boolean {
  const secret = process.env.PROXYMINER_REVIEW_COOKIE_SECRET;
  if (!secret) return false;
  const [issuedStr, sig] = value.split(".");
  if (!issuedStr || !sig) return false;
  const expected = createHmac("sha256", secret).update(issuedStr).digest("hex");
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
