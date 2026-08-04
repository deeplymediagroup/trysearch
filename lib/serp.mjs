/**
 * The SERP → metrics engine, shared by the nightly crawler, the API/MCP ops, and the
 * Add-Keywords action. One implementation of "fetch a SERP, persist it, score the keyword"
 * so on-demand metrics and the crawl can never drift apart.
 *
 * Every function takes `query(sql, params) => Promise<rows[]>` so it runs against either
 * side's Postgres helper (scripts/crawl.mjs passes `(sql, p) => q(db, sql, p)`; the Next
 * app passes `q` from lib/db.ts directly).
 */
import { appleSearchRanked, appleLookup, suggestDepth } from "./stores/apple.mjs";
import { playSearchRanked, playAppDetail, playSuggest } from "./stores/play.mjs";
import { setFetchSink } from "./stores/http.mjs";
import {
  difficulty,
  serpOutlier,
  beatable,
  popularityProxy,
  popularityProxyAndroid,
  estDownloadsAtRank1,
} from "./scoring/scores.mjs";

export const todayUTC = () => new Date().toISOString().slice(0, 10);

export const normalizeTerm = (term) =>
  String(term).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Point the fetch layer's log/cache sink at a query function. Safe to call repeatedly. */
export function ensureFetchSink(query) {
  setFetchSink({ query: async (sql, params = []) => ({ rows: await query(sql, params) }) });
}

export async function fetchIosSerp(kw) {
  const serp = await appleSearchRanked(kw.term, kw.country);
  if (!serp.ids.length) return { orderedIds: [], top: [], depth: 0 };

  // Provenance check: Apple echoes back which store it actually served. A mismatch means US
  // data would be silently labelled as another country — nearly invisible, and it poisons
  // every downstream metric.
  if (serp.storeFront && serp.requestedStoreFront && serp.storeFront !== serp.requestedStoreFront) {
    throw new Error(`storefront mismatch: asked ${serp.requestedStoreFront}, Apple served ${serp.storeFront}`);
  }

  // Only 8 apps arrive hydrated; ranks 9-250 need /lookup, which is effectively unthrottled
  // and batches 200 per call.
  const top30 = serp.ids.slice(0, 30);
  const meta = await appleLookup(top30, kw.country);
  const byId = new Map(meta.map((m) => [m.store_id, m]));
  const subtitles = new Map(serp.hydrated.map((h) => [h.store_id, h.subtitle]));

  const top = top30.map((id, i) => {
    const m = byId.get(id);
    return {
      position: i + 1,
      store_id: id,
      name: m?.name ?? null,
      subtitle: subtitles.get(id) ?? null,
      rating_count: m?.rating_count ?? null,
      rating_average: m?.rating_average ?? null,
      meta: m ?? null,
    };
  });

  return { orderedIds: serp.ids, top, depth: serp.ids.length };
}

export async function fetchAndroidSerp(kw) {
  const rows = await playSearchRanked(kw.term, kw.country);
  if (!rows.length) return { orderedIds: [], top: [], depth: 0 };

  // Android difficulty uses REAL INSTALLS rather than the rating-count proxy iOS is stuck
  // with, so the top 10 get a detail fetch. Play has no batch endpoint, hence the cap.
  const top = [];
  for (const row of rows.slice(0, 30)) {
    let detail = null;
    if (row.rank <= 10) detail = await playAppDetail(row.store_id, kw.country).catch(() => null);
    top.push({
      position: row.rank,
      store_id: row.store_id,
      name: detail?.name ?? null,
      subtitle: detail?.summary ?? null,
      rating_count: detail?.rating_count ?? null,
      rating_average: detail?.rating_average ?? row.rating_average ?? null,
      real_installs: detail?.real_installs ?? null,
      meta: detail,
    });
  }

  return { orderedIds: rows.map((r) => r.store_id), top, depth: rows.length };
}

export function titleMatchOf(name, term) {
  if (!name) return null;
  const bag = new Set(String(name).normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const words = String(term).normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => bag.has(w));
}

/**
 * Persists one SERP in TWO round trips instead of sixty.
 *
 * The naive loop did `upsertApp` + one insert per row, so a 30-row SERP cost 60 sequential
 * round trips. Against Neon that measured at 72ms each — 4.3 seconds per keyword of pure
 * database latency, versus about 1 second of actual upstream work. Batching both into
 * multi-row statements is what actually shortens the nightly run.
 */
export async function persistSerp(query, kw, top, runDate = todayUTC()) {
  const rows = top.filter((r) => r.store_id);
  if (!rows.length) return;

  // --- 1. every app in one statement --------------------------------------
  const appCols = 8;
  const appValues = [];
  const appParams = [];
  rows.forEach((row, i) => {
    const m = row.meta ?? {};
    const base = i * appCols;
    appValues.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
    appParams.push(
      kw.platform,
      String(row.store_id),
      row.name ?? m.name ?? `(app ${row.store_id})`,
      m.bundle_id ?? null,
      m.developer_name ?? null,
      m.developer_id ?? null,
      m.icon_url ?? null,
      m.primary_genre ?? null,
    );
  });

  const appRows = await query(
    `insert into apps (platform, store_id, name, bundle_id, developer_name, developer_id, icon_url, primary_genre)
     values ${appValues.join(",")}
     on conflict (platform, store_id) do update set
       -- coalesce so a thin SERP row never blanks a field a richer source already filled
       name           = coalesce(excluded.name, apps.name),
       bundle_id      = coalesce(excluded.bundle_id, apps.bundle_id),
       developer_name = coalesce(excluded.developer_name, apps.developer_name),
       developer_id   = coalesce(excluded.developer_id, apps.developer_id),
       icon_url       = coalesce(excluded.icon_url, apps.icon_url),
       primary_genre  = coalesce(excluded.primary_genre, apps.primary_genre),
       updated_at     = now()
     returning id, store_id`,
    appParams,
  );
  const idByStoreId = new Map(appRows.map((r) => [String(r.store_id), r.id]));

  // --- 2. every SERP position in one statement ------------------------------
  const serpCols = 7;
  const serpValues = [];
  const serpParams = [];
  let n = 0;
  for (const row of rows) {
    const appId = idByStoreId.get(String(row.store_id));
    if (!appId) continue;
    const base = n * serpCols;
    serpValues.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    serpParams.push(kw.keyword_id, runDate, row.position, appId, row.rating_count, row.rating_average, titleMatchOf(row.name, kw.term));
    n++;
  }
  if (!n) return;

  await query(
    `insert into serp_results (keyword_id, captured_on, position, app_id, rating_count, rating_average, title_match)
     values ${serpValues.join(",")}
     on conflict (keyword_id, captured_on, position) do update set
       app_id = excluded.app_id, rating_count = excluded.rating_count,
       rating_average = excluded.rating_average, title_match = excluded.title_match`,
    serpParams,
  );
}

/** Difficulty + outliers + beatability from a SERP we already hold. No extra fetch. */
export async function updateKeywordSerpMetrics(query, kw, { top, depth }) {
  const diff = difficulty({ top: top.slice(0, 10), term: kw.term, serpDepth: depth, platform: kw.platform });
  const outlier = serpOutlier({ top: top.slice(0, 10), platform: kw.platform });
  const beat = beatable({ top: top.slice(0, 10), term: kw.term, platform: kw.platform });

  await query(
    `update keywords set difficulty = $2, difficulty_parts = $3::jsonb, serp_depth = $4,
                         serp_outlier = $5, metrics_updated_at = now()
      where id = $1`,
    [
      kw.keyword_id,
      diff.value,
      JSON.stringify({ ...(diff.parts ?? {}), outlier: outlier.apps, beatable: beat.evidence, beatable_value: beat.value }),
      depth,
      outlier.value === true,
    ],
  );
  return diff;
}

/**
 * The full on-demand path: never-seen (term, platform, country) → real popularity AND
 * difficulty in one pass, cached in `keywords` so the next caller gets it for free.
 * One SERP fetch + one autocomplete depth walk; ~3s iOS, ~10s Android (top-10 detail fetches).
 * The nightly crawl refreshes/refines the same rows later — same tables, same provenance rules.
 */
export async function liveKeywordMetrics(query, { term, platform, country }) {
  const normalized = normalizeTerm(term);
  const rows = await query(
    `insert into keywords (term, term_normalized, platform, country, word_count)
     values ($1,$2,$3,$4,$5)
     on conflict (term_normalized, platform, country) do update set term = keywords.term
     returning id`,
    [term, normalized, platform, country, normalized.split(/\s+/).length],
  );
  const kw = { keyword_id: rows[0].id, term, term_normalized: normalized, platform, country };

  // SERP first: it feeds difficulty AND (on Android) the install counts popularity wants.
  const serp = platform === "ios" ? await fetchIosSerp(kw) : await fetchAndroidSerp(kw);
  await persistSerp(query, kw, serp.top);
  await updateKeywordSerpMetrics(query, kw, serp);

  const depth = await suggestDepth(term, country, platform, platform === "android" ? { playSuggest } : {});
  const pop = platform === "android"
    ? popularityProxyAndroid(depth, serp.top.map((t) => Number(t.real_installs)).filter(Boolean))
    : popularityProxy(depth);

  await query(
    `update keywords
        set popularity_estimate = $2,
            popularity_source = case when popularity is not null then 'store' else 'proxy' end,
            est_downloads_rank1 = $3,
            metrics_updated_at = now()
      where id = $1`,
    [kw.keyword_id, pop.value, estDownloadsAtRank1({ popularity: pop.value, platform })],
  );

  const [out] = await query(
    `select term, popularity, popularity_estimate, difficulty, serp_depth, serp_outlier, metrics_updated_at
       from keywords where id = $1`,
    [kw.keyword_id],
  );
  return out;
}
