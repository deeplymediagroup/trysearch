"use server";

/**
 * Interactive research actions — the only place the Next app talks to a store directly.
 * Everything else reads the database; the crawler does the fetching.
 *
 * Both of these are rate-limit hazards, so both go through the shared fetch layer's cache
 * (upstream_cache, 6h TTL for autocomplete) and the UI debounces on top of that. Without
 * both, one enthusiastic user gets the whole platform throttled.
 */
import { q, q1 } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { appleAutocomplete, suggestDepth } from "@/lib/stores/apple.mjs";
import { playSuggest, playSuggestBroad } from "@/lib/stores/play.mjs";

/**
 * Points the fetch layer at the app's connection pool, so an interactive probe reads and
 * writes the SAME upstream_cache the nightly crawler fills. That sharing is what keeps the
 * simulator from hammering Apple: a prefix the crawler already walked costs zero calls.
 */
let sinkReady = false;
function withSink() {
  if (sinkReady) return;
  setFetchSink({ query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) });
  sinkReady = true;
}

/**
 * A live autocomplete probe for the simulator. Returns each suggestion enriched with whatever
 * popularity and difficulty we have cached for it — never blocks on computing them.
 */
export async function autocompleteProbe(prefix: string, platform: "ios" | "android", country: string) {
  const clean = prefix.trim().slice(0, 60);
  if (clean.length < 1) return { suggestions: [] as any[], source: null };

  withSink();

  let terms: string[] = [];
  let source = "";
  try {
    if (platform === "ios") {
      terms = await appleAutocomplete(clean, country);
      source = "Apple MZSearchHints — ordered by Apple's own popularity ranking, capped at 10.";
    } else {
      // IJ4APc is the Play Store's own suggest (authoritative order, exactly 5); ds=play is
      // broader but noisier. Show both, deduped, with IJ4APc first.
      const [own, broad] = await Promise.all([playSuggest(clean, country), playSuggestBroad(clean, country)]);
      terms = [...new Set([...own, ...broad])];
      source = "Play Store suggest (5, authoritative) merged with Google's ds=play autocomplete (up to 15, broader).";
    }
  } catch (err: any) {
    return { suggestions: [], source: null, error: err.message };
  }

  // Enrich from what we already know. A miss shows as an em dash, not a zero.
  const suggestions = [];
  for (let i = 0; i < terms.length; i++) {
    const normalized = terms[i].normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const known = await q1<{ popularity: number | null; popularity_estimate: number | null; difficulty: number | null }>(
      `select popularity, popularity_estimate, difficulty from keywords
        where term_normalized = $1 and platform = $2 and country = $3`,
      [normalized, platform, country],
    );
    suggestions.push({
      position: i,
      term: terms[i],
      popularity: known?.popularity ?? null,
      popularity_estimate: known?.popularity_estimate ?? null,
      difficulty: known?.difficulty ?? null,
    });
  }

  return { suggestions, source };
}

/**
 * Keyword reveal — at what character count does this keyword first appear in autocomplete,
 * and at what position? Exactly the probe behind the popularity proxy, surfaced directly.
 */
export async function keywordRevealProbe(term: string, platform: "ios" | "android", country: string) {
  const clean = term.trim().slice(0, 60);
  if (!clean) return null;

  withSink();

  try {
    const depth =
      platform === "ios"
        ? await suggestDepth(clean, country, "ios")
        : await suggestDepth(clean, country, "android", { playSuggest: (p: string, c: string) => playSuggest(p, c) });

    const { popularityProxy } = await import("@/lib/scoring/scores.mjs");
    const scored = popularityProxy(depth);

    return {
      term: clean,
      revealed_at_char: depth.length,
      position: depth.index,
      best_position: depth.best,
      prefixes_seen: depth.hits,
      popularity_estimate: scored.value,
      parts: scored.parts,
    };
  } catch (err: any) {
    return { term: clean, error: err.message, revealed_at_char: null, position: null, popularity_estimate: null };
  }
}
