/**
 * Grounded /ask route — server-side AI assistant.
 *
 *   POST /api/ask
 *   { question: string, company_id: string, filing_id?: string }
 *
 * Pipeline:
 *   1. Load company + filing (and optional prior) from fixtures or DB.
 *   2. Build context fact pack (single-company / single-filing only).
 *   3. Call AI Gateway with the structured AnswerSchema.
 *   4. Validate citations resolve to artifacts in the fact pack —
 *      drop any that don't, then escalate scope_note if many were
 *      dropped.
 *   5. Append an audit row to ask_interactions for replay/QA.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { generateAnswer } from "@/lib/ai/gateway";
import { buildUserPrompt, SYSTEM_PROMPT } from "@/lib/ai/prompts";
import {
  buildContext,
  validateCitations,
} from "@/lib/ai/context-assembler";
import { REFUSAL } from "@/lib/ai/citation-schema";
import {
  getCompany,
  getLatestFiling,
  getFilingDetail,
  listFilings,
  fixtureMode,
} from "@/lib/data/source";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestSchema = z.object({
  question: z.string().min(2).max(800),
  company_id: z.string().min(1).max(32),
  filing_id: z.string().optional(),
  // Bring-your-own Google AI Studio key. The user pastes it once in
  // the browser; the browser sends it on every /api/ask call. We use
  // it for the Gemini call and never persist it (audit log records
  // only the question/answer/citations, never the key).
  gemini_api_key: z.string().min(20).max(200).optional(),
});

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = RequestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const { question, company_id, filing_id, gemini_api_key } = parsed;

  const company = await getCompany(company_id);
  if (!company) {
    return NextResponse.json({ error: "company not found" }, { status: 404 });
  }

  const filing = filing_id
    ? await getFilingDetail(filing_id)
    : await getLatestFiling(company_id);
  if (!filing) {
    return NextResponse.json({ error: "filing not found" }, { status: 404 });
  }

  const all = await listFilings(company_id);
  const priorId = all.find((f) => f.id !== filing.id)?.id ?? null;
  const prior = priorId ? await getFilingDetail(priorId) : null;

  const ctx = buildContext(company, filing, prior);

  // BYOK: refuse if the request didn't include a Google AI Studio key.
  // Deterministic facts are still served via /company/[id]; the
  // assistant just needs a free Gemini key from
  // aistudio.google.com/apikey (sent in the request body as
  // gemini_api_key).
  if (!gemini_api_key) {
    return NextResponse.json({
      ...REFUSAL,
      summary:
        "Bring your own Google AI Studio key. Get a free key at " +
        "aistudio.google.com/apikey and pass it in the request body as " +
        "`gemini_api_key`. All deterministic facts are still available " +
        "on the company page without a key.",
    });
  }

  let answer;
  try {
    answer = await generateAnswer({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(question, ctx.fact_pack),
      apiKey: gemini_api_key,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ...REFUSAL,
        summary:
          "The model couldn't return a structured answer. The deterministic " +
          "facts on the company page are still available.",
        scope_explanation: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }

  // Validate citations against the loaded context. Drop any that don't
  // resolve, escalate scope if many were dropped.
  const { valid, rejected } = validateCitations(answer.citations, ctx);
  if (rejected.length > 0 && valid.length === 0) {
    return NextResponse.json({
      ...REFUSAL,
      summary:
        "The model's answer cited artifacts that aren't in the loaded context. " +
        "Try a more specific question about this filing, or open a different one.",
    });
  }
  const finalAnswer = { ...answer, citations: valid };

  // Audit log if Postgres is wired. In fixture mode we skip — the
  // route still returns the answer.
  if (!fixtureMode()) {
    try {
      const { db, schema } = await import("@/lib/db/client");
      await db().insert(schema.ask_interactions).values({
        company_id,
        filing_id: filing.id,
        question,
        context_summary: { fact_pack_keys: Object.keys(ctx.fact_pack) },
        citations: finalAnswer.citations,
        answer: finalAnswer.summary,
        model: process.env.PROXYMINER_ASSISTANT_MODEL ?? "gemini-flash-latest",
        scope_violation: rejected.length > 0,
      });
    } catch {
      // Audit log failure must not break the user-facing answer.
    }
  }

  return NextResponse.json(finalAnswer);
}
