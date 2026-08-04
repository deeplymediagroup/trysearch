/**
 * Typed wrapper over lib/ai.mjs — the single AI seam. The implementation lives in the
 * .mjs file so the crawler can import it with plain node; this file only restores the
 * generic on aiJson for TypeScript callers.
 */
import { AI_MODEL as MODEL, aiEnabled as enabled, aiJson as json } from "./ai.mjs";

export const AI_MODEL: string = MODEL;
export const aiEnabled: () => boolean = enabled;
export const aiJson = json as <T>(args: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}) => Promise<T>;
