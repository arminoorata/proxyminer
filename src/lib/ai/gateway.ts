/**
 * Direct Google Gemini provider via the AI SDK. Swapped from the
 * Vercel AI Gateway path to keep the assistant on Google's free tier
 * — same model alias equity.arminoorata.com uses.
 *
 * Auth: GOOGLE_GENERATIVE_AI_API_KEY (AI SDK default for
 * @ai-sdk/google). Free key from aistudio.google.com/apikey, added to
 * the Vercel project env vars. Route gracefully refuses if missing.
 *
 * Model anchor: gemini-flash-latest. The alias is Google's "latest
 * Flash" router; specific 2.x names are on a June 17 2026 deprecation
 * calendar so they're not pinned. Override via
 * PROXYMINER_ASSISTANT_MODEL if needed.
 */
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";

import { Answer, AnswerSchema } from "./citation-schema";

const DEFAULT_MODEL = "gemini-flash-latest";

export async function generateAnswer(opts: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<Answer> {
  const modelId = process.env.PROXYMINER_ASSISTANT_MODEL ?? DEFAULT_MODEL;

  const { object } = await generateObject({
    model: google(modelId),
    schema: AnswerSchema,
    system: opts.systemPrompt,
    prompt: opts.userPrompt,
    temperature: 0.2,
  });
  return object;
}
