/**
 * The one place this product talks to Claude. Plain .mjs so the crawler can import it
 * without a build step (same rule as lib/stores/*.mjs); the Next app reaches it through
 * the typed wrapper lib/ai.ts. Everything else in this product is $0/month; these calls
 * are the only marginal cost, so every feature using this module is gated behind an
 * explicit button or a bounded crawl batch.
 *
 * Structured outputs (output_config.format) guarantee parseable JSON — no regex rescue.
 */
import Anthropic from "@anthropic-ai/sdk";

export const AI_MODEL = "claude-opus-5";

export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client = null;
function getClient() {
  if (!aiEnabled()) throw new Error("ANTHROPIC_API_KEY is not set — AI features are off.");
  if (!client) client = new Anthropic();
  return client;
}

/**
 * One JSON-shaped completion. Server-side fallback is on so a safety-classifier
 * decline re-runs on Opus 4.8 instead of failing the request.
 */
export async function aiJson({ system, prompt, schema, maxTokens = 16000 }) {
  const anthropic = getClient();

  const response = await anthropic.beta.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty model response.");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// AI feature #4 — keyword relevance (03-ALGORITHMS.md §6)
// ---------------------------------------------------------------------------

/**
 * Score how well each keyword's search intent matches what the app does, 0–100, with a
 * one-sentence reason. Batched — many keywords per call — and cached by the caller on
 * discovered_keywords.relevance; never blocks a page render.
 *
 * @returns {Promise<Array<{term: string, relevance: number, reason: string}>>}
 */
export async function scoreRelevance({ app, terms }) {
  if (!terms.length) return [];
  const result = await aiJson({
    system:
      "You score App Store search keywords for intent match against one app. 100 = a searcher typing this is looking for exactly this kind of app; 50 = adjacent need, plausible install; 0 = unrelated or looking for a specific other product. Brand names of OTHER apps score ≤10. Score every keyword given, reason under 15 words.",
    prompt:
      `APP\nName: ${app.name ?? ""}\nSubtitle: ${app.subtitle ?? ""}\nDescription: ${String(app.description ?? "").slice(0, 1500)}\n\n` +
      `KEYWORDS (score all ${terms.length}):\n${terms.join("\n")}`,
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              term: { type: "string" },
              // Structured outputs reject minimum/maximum on integers, so range is enforced
              // by the clamp below instead of the schema.
              relevance: { type: "integer" },
              reason: { type: "string" },
            },
            required: ["term", "relevance", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    },
  });
  return result.scores.map((s) => ({ ...s, relevance: Math.max(0, Math.min(100, Math.round(s.relevance))) }));
}

// ---------------------------------------------------------------------------
// AI candidate generation — the "goes wide" half of discovery
// ---------------------------------------------------------------------------

/**
 * Read the app's listing plus its competitors' and propose search phrases a real person
 * would type: intent terms, problem phrases, audience niches, long-tail qualifiers, and
 * competitor-brand derivatives ("… alternative", "apps like …"). The caller MUST verify
 * every candidate against live autocomplete before inserting — never trust unverified
 * model output as demand.
 *
 * @returns {Promise<string[]>}
 */
export async function generateKeywordCandidates({ app, competitors = [], existing = [], max = 60 }) {
  const result = await aiJson({
    system:
      "You are an ASO keyword researcher. Propose search phrases real users type into the App Store — lowercase, 2-4 words, no punctuation. Mix: user problems and goals, audience niches, feature intents, long-tail qualifiers, and competitor-derivative queries ('<competitor> alternative', 'apps like <competitor>'). Never repeat a phrase from the EXISTING list. No made-up brand names.",
    prompt:
      `MY APP\nName: ${app.name ?? ""}\nSubtitle: ${app.subtitle ?? ""}\nDescription: ${String(app.description ?? "").slice(0, 1500)}\n\n` +
      `COMPETITOR LISTINGS:\n${competitors
        .map((c) => `- ${c.name ?? ""} — ${c.subtitle ?? ""} ${String(c.description ?? "").slice(0, 300)}`)
        .join("\n")}\n\n` +
      `EXISTING (do not repeat): ${existing.slice(0, 300).join(", ")}\n\nPropose up to ${max} candidates.`,
    schema: {
      type: "object",
      properties: { candidates: { type: "array", items: { type: "string" } } },
      required: ["candidates"],
      additionalProperties: false,
    },
  });
  return result.candidates.slice(0, max);
}

/**
 * Pure verification gate for AI candidates: a candidate earns a row only if live
 * autocomplete surfaces it — exactly it, or a longer phrase starting with it.
 */
export function verifyCandidate(term, suggestions) {
  const n = normalizeTerm(term);
  if (!n) return false;
  return suggestions.some((s) => {
    const m = normalizeTerm(s);
    return m === n || m.startsWith(`${n} `);
  });
}

function normalizeTerm(t) {
  return String(t ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
