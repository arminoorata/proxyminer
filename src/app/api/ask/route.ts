/**
 * Grounded /ask route — server-side AI assistant.
 *
 *   POST /api/ask
 *   { question: string, company_id: string, filing_id?: string }
 *
 * Pipeline:
 *   1. Load company + filing (and optional prior) from fixtures or DB.
 *   2. Build context fact pack (single-company / single-filing only).
 *   3. Call BYOK Gemini with the structured AnswerSchema.
 *   4. Validate citations resolve to artifacts in the fact pack —
 *      drop any that don't, then escalate scope_note if many were
 *      dropped.
 *   5. Append an audit row to ask_interactions for replay/QA.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { categorizeAskProviderError } from "@/lib/ai/ask-error";
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
});

const NO_STORE_HEADERS = { "cache-control": "no-store" };

function jsonNoStore<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}


export async function POST(req: NextRequest) {
  // BYOK key arrives as a custom header so it never lives in the
  // request body (which is more commonly persisted by error tracking,
  // logs, and middleware tooling than headers). The header is read
  // once and never written to a log or DB.
  const gemini_api_key = req.headers.get("x-gemini-api-key") ?? "";

  let parsed;
  try {
    parsed = RequestSchema.parse(await req.json());
  } catch {
    return jsonNoStore({ error: "invalid request body" }, 400);
  }
  const { question, company_id, filing_id } = parsed;

  const company = await getCompany(company_id);
  if (!company) {
    return jsonNoStore({ error: "company not found" }, 404);
  }

  const filing = filing_id
    ? await getFilingDetail(filing_id)
    : await getLatestFiling(company_id);
  if (!filing) {
    return jsonNoStore({ error: "filing not found" }, 404);
  }

  const all = await listFilings(company_id);
  const priorId = all.find((f) => f.id !== filing.id)?.id ?? null;
  const prior = priorId ? await getFilingDetail(priorId) : null;

  const ctx = buildContext(company, filing, prior);

  // BYOK: refuse if the request didn't include a Google AI Studio key
  // (sent as the X-Gemini-Api-Key header). Deterministic facts remain
  // available on /company/[id] without a key.
  if (gemini_api_key.length < 20) {
    return jsonNoStore({
      ...REFUSAL,
      summary:
        "Bring your own Google AI Studio key. Get a free key at " +
        "aistudio.google.com/apikey and configure it in the Ask panel. " +
        "All deterministic facts are still available on the company page " +
        "without a key.",
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
    const { scope_explanation, category } = categorizeAskProviderError(err);
    return jsonNoStore({
      ...REFUSAL,
      summary: scope_explanation,
      scope_explanation: `category: ${category}`,
    });
  }

  // Validate citations against the loaded context. Drop any that don't
  // resolve, escalate scope if many were dropped.
  const { valid, rejected } = validateCitations(answer.citations, ctx);
  if (rejected.length > 0 && valid.length === 0) {
    return jsonNoStore({
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

  return jsonNoStore(finalAnswer);
}
