/**
 * BYOK Google Gemini provider. The user's Google AI Studio key is
 * passed in the X-Gemini-Api-Key request header; we instantiate a per-request provider
 * with it and never persist it. Mirrors the equity.arminoorata.com
 * pattern (free for everyone — each user spends their own Google
 * free-tier quota, Armi pays $0).
 *
 * Get a free key from aistudio.google.com/apikey.
 *
 * Model anchor: gemini-flash-latest. The alias is Google's "latest
 * Flash" router; specific 2.x names are on a June 17 2026 deprecation
 * calendar so they're not pinned.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";

import { Answer, AnswerSchema } from "./citation-schema";

const DEFAULT_MODEL = "gemini-flash-latest";

export async function generateAnswer(opts: {
  systemPrompt: string;
  userPrompt: string;
  apiKey: string;
}): Promise<Answer> {
  const modelId = process.env.PROXYMINER_ASSISTANT_MODEL ?? DEFAULT_MODEL;
  const provider = createGoogleGenerativeAI({ apiKey: opts.apiKey });

  const { object } = await generateObject({
    model: provider(modelId),
    schema: AnswerSchema,
    system: opts.systemPrompt,
    prompt: opts.userPrompt,
    temperature: 0.2,
  });
  return object;
}
