/**
 * AI Gateway client. Vercel AI Gateway routes provider calls; AI SDK
 * wraps streaming + structured generation. Default model is
 * claude-haiku-4-5 (fast + cheap for the grounded pattern); set
 * PROXYMINER_ASSISTANT_MODEL to override.
 */
import { gateway } from "ai";

import { Answer, AnswerSchema } from "./citation-schema";
import { generateObject } from "ai";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

export async function generateAnswer(opts: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<Answer> {
  const modelId = process.env.PROXYMINER_ASSISTANT_MODEL ?? DEFAULT_MODEL;

  const { object } = await generateObject({
    model: gateway(modelId),
    schema: AnswerSchema,
    system: opts.systemPrompt,
    prompt: opts.userPrompt,
    temperature: 0.2,
  });
  return object;
}
