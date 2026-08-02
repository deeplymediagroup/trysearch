import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Only exists so tests can import modules that use the `@/` alias from tsconfig paths —
 * vitest does not read tsconfig paths on its own. Everything else stays at vitest's defaults.
 */
export default defineConfig({
  resolve: { alias: { "@": path.dirname(fileURLToPath(import.meta.url)) } },
});
