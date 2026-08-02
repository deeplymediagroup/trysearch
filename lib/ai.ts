/**
 * The one place the app talks to Claude. Everything else in this product is $0/month;
 * these calls are the only marginal cost, so every feature that uses this module is
 * gated behind an explicit button and (where it matters) a cooldown.
 *
 * Structured outputs (output_config.format) guarantee parseable JSON — no regex rescue.
 */
import Anthropic from "@anthropic-ai/sdk";

export const AI_MODEL = "claude-opus-5";

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!aiEnabled()) throw new Error("ANTHROPIC_API_KEY is not set — AI features are off.");
  if (!client) client = new Anthropic();
  return client;
}

/**
 * One JSON-shaped completion. Server-side fallback is on so a safety-classifier
 * decline re-runs on Opus 4.8 instead of failing the request.
 */
export async function aiJson<T>({
  system,
  prompt,
  schema,
  maxTokens = 16000,
}: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const anthropic = getClient();

  const response = await (anthropic.beta.messages.create as any)({
    model: AI_MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.find((b: any) => b.type === "text")?.text;
  if (!text) throw new Error("Empty model response.");
  return JSON.parse(text) as T;
}
