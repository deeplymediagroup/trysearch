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
    const known = await q1<{ popularity: number | null; popularity_estimate: number | null; difficulty: number | null; tracked: boolean }>(
      `select k.popularity, k.popularity_estimate, k.difficulty,
              exists (select 1 from tracked_keywords tk where tk.keyword_id = k.id) as tracked
         from keywords k
        where k.term_normalized = $1 and k.platform = $2 and k.country = $3`,
      [normalized, platform, country],
    );
    suggestions.push({
      position: i,
      term: terms[i],
      popularity: known?.popularity ?? null,
      popularity_estimate: known?.popularity_estimate ?? null,
      difficulty: known?.difficulty ?? null,
      tracked: known?.tracked ?? false,
    });
  }

  return { suggestions, source };
}

/**
 * Click-through from a suggestion (Workstream H): the live top-10 SERP for one term, with
 * outlier evidence and tracked-app flags. The fetch doubles as Workstream G's on-demand
 * metrics pass — the SERP is persisted and the keyword scored, so the next caller gets both
 * for free.
 */
export async function serpProbe(term: string, platform: "ios" | "android", country: string) {
  const clean = term.trim().slice(0, 60);
  if (!clean) return null;
  withSink();

  try {
    const { fetchIosSerp, fetchAndroidSerp, persistSerp, updateKeywordSerpMetrics, normalizeTerm } = await import("@/lib/serp.mjs");
    const { serpOutlier, popularityProxy, popularityProxyAndroid } = await import("@/lib/scoring/scores.mjs");
    const { suggestDepth } = await import("@/lib/stores/apple.mjs");

    const normalized = normalizeTerm(clean);
    const [kwRow] = await q<{ id: string }>(
      `insert into keywords (term, term_normalized, platform, country, word_count)
       values ($1,$2,$3,$4,$5)
       on conflict (term_normalized, platform, country) do update set term = keywords.term
       returning id`,
      [clean, normalized, platform, country, normalized.split(/\s+/).length],
    );
    const kw = { keyword_id: kwRow.id, term: clean, term_normalized: normalized, platform, country };

    const serp = platform === "ios" ? await fetchIosSerp(kw) : await fetchAndroidSerp(kw);
    await persistSerp(q, kw, serp.top);
    await updateKeywordSerpMetrics(q, kw, serp);

    const depth = await suggestDepth(clean, country, platform, platform === "android" ? { playSuggest: (p: string, c: string) => playSuggest(p, c) } : {});
    const pop = platform === "android"
      ? popularityProxyAndroid(depth, serp.top.map((t: any) => Number(t.real_installs)).filter(Boolean))
      : popularityProxy(depth);
    await q(
      `update keywords set popularity_estimate = $2,
              popularity_source = case when popularity is not null then 'store' else 'proxy' end,
              metrics_updated_at = now()
        where id = $1`,
      [kw.keyword_id, pop.value],
    );

    const outlier = serpOutlier({ top: serp.top.slice(0, 10), platform } as any);
    const outlierIds = new Set((outlier.apps ?? []).map((a: any) => String(a.store_id ?? a)));
    const trackedIds = new Set(
      (await q<{ store_id: string }>(
        `select a.store_id from tracked_apps ta join apps a on a.id = ta.app_id
          where ta.is_active and a.platform = $1`,
        [platform],
      )).map((r) => String(r.store_id)),
    );

    const metrics = await q1<{ popularity: number | null; popularity_estimate: number | null; difficulty: number | null }>(
      `select popularity, popularity_estimate, difficulty from keywords where id = $1`,
      [kw.keyword_id],
    );

    return {
      term: clean,
      depth: serp.depth,
      metrics,
      top: serp.top.slice(0, 10).map((r: any) => ({
        position: r.position,
        store_id: String(r.store_id),
        name: r.name,
        subtitle: r.subtitle,
        rating_count: r.rating_count,
        rating_average: r.rating_average,
        icon_url: r.meta?.icon_url ?? null,
        outlier: outlierIds.has(String(r.store_id)),
        tracked: trackedIds.has(String(r.store_id)),
      })),
    };
  } catch (err: any) {
    return { term: clean, error: err.message, top: [] };
  }
}

/**
 * Click-through from a SERP row: the app's listing detail, with keyword highlighting done
 * client-side. iOS gets the IAP range too (one extra fetch, only on demand).
 */
export async function appDetailProbe(platform: "ios" | "android", storeId: string, country: string) {
  withSink();
  try {
    if (platform === "ios") {
      const { appleLookup, appleAppSSR, appleInAppPurchases } = await import("@/lib/stores/apple.mjs");
      const [meta] = await appleLookup([storeId], country);
      if (!meta) return { error: `No iOS app ${storeId} in ${country.toUpperCase()}.` };
      const ssr = await appleAppSSR(storeId, country).catch(() => null);
      const iaps = await appleInAppPurchases(storeId, country).catch(() => []);
      const prices = (iaps ?? []).map((i: any) => i.price_cents).filter((p: any) => p != null);
      return {
        store_id: String(storeId),
        name: meta.name,
        subtitle: ssr?.subtitle ?? null,
        description: (ssr?.description ?? meta.description ?? "").slice(0, 1200),
        rating_average: meta.rating_average,
        rating_count: meta.rating_count,
        price_cents: meta.price_cents,
        currency: meta.currency ?? "USD",
        category: meta.primary_genre ?? null,
        version: meta.version ?? null,
        icon_url: meta.icon_url ?? null,
        iap_range: prices.length ? { min_cents: Math.min(...prices), max_cents: Math.max(...prices), count: prices.length } : null,
      };
    }
    const { playAppDetail } = await import("@/lib/stores/play.mjs");
    const d = await playAppDetail(storeId, country);
    if (!d) return { error: `No Play app ${storeId} in ${country.toUpperCase()}.` };
    return {
      store_id: String(storeId),
      name: d.name,
      subtitle: d.summary ?? null,
      description: (d.description ?? "").slice(0, 1200),
      rating_average: d.rating_average,
      rating_count: d.rating_count,
      price_cents: d.price_cents,
      currency: d.currency ?? "USD",
      category: d.primary_genre ?? null,
      version: null,
      icon_url: d.icon_url ?? null,
      real_installs: d.real_installs ?? null,
      iap_range: null,
    };
  } catch (err: any) {
    return { error: err.message };
  }
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
