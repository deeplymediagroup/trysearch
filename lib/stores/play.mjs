/**
 * The one Google Play client.
 *
 * ⚠️ This deliberately does NOT depend on the `google-play-scraper` npm package. Its README
 * declares it unmaintained, it breaks 3-6 times a year, npm publishing lags merges by months,
 * and its `throttle` option has an open deadlock bug — `inThrottle` is set without a
 * try/finally, so a single rejected request (404/429/503) leaves it stuck true and every
 * later call polls forever. One bad app id silently freezes the whole scraper.
 *
 * So: the index paths are read from it and VENDORED here as configuration (§PATHS below),
 * and rate limiting lives in our own fetch layer.
 *
 * Two structural advantages over iOS that this client exists to exploit (02 §6.5a):
 *   1. `realInstalls` — an EXACT install count, free. Apple exposes nothing comparable at
 *      any price. Best free competitive-sizing signal on either store.
 *   2. Play indexes the FULL description, and it is publicly readable. A competitor's
 *      description text literally IS their keyword strategy. There is no iOS equivalent.
 */
import { fetchJson, fetchText, TTL, normalizeTerm } from "./http.mjs";

/**
 * Vendored index paths into Play's positional `ds:` payloads. TREAT AS CONFIGURATION, NOT
 * CODE — Google rotates these without notice. The canary in scripts/smoke.mjs asserts
 * title/appId/score against known apps so a rotation fails loudly instead of silently.
 * Verified live against com.google.android.apps.fitness (root ds:5) on 2026-07-31.
 */
const PATHS = {
  title: [1, 2, 0, 0],
  summary: [1, 2, 73, 0, 1], // short description, 80 chars — indexed by Play search
  description: [1, 2, 72, 0, 1], // full description, 4,000 chars — ALSO indexed
  installs: [1, 2, 13, 0], // bucketed string: "100,000,000+"
  realInstalls: [1, 2, 13, 2], // the exact number: 360532190 — use THIS
  score: [1, 2, 51, 0, 1],
  ratings: [1, 2, 51, 2, 1],
  reviews: [1, 2, 51, 3, 1],
  histogram: [1, 2, 51, 1],
  priceMicros: [1, 2, 57, 0, 0, 0, 0, 1, 0, 0], // micros — divide by 1e6
  currency: [1, 2, 57, 0, 0, 0, 0, 1, 0, 1],
  developer: [1, 2, 68, 0],
  developerId: [1, 2, 68, 1, 4, 2],
  genre: [1, 2, 79, 0, 0, 0],
  genreId: [1, 2, 79, 0, 0, 2],
  released: [1, 2, 10, 0],
  updated: [1, 2, 145, 0, 1, 0], // unix seconds — ×1000
  icon: [1, 2, 95, 0, 3, 2],
  screenshots: [1, 2, 78, 0],
  contentRating: [1, 2, 9, 0],
};

const at = (obj, path) => path.reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

// ---------------------------------------------------------------------------
// 1. Suggest — two live sources, implemented BOTH because they complement each other
// ---------------------------------------------------------------------------

/**
 * The Play Store's OWN suggest (rpcid IJ4APc) — what users actually see inside the app,
 * so its ORDER is the authoritative Play demand signal. Use this for the popularity proxy.
 *
 * ⚠️ Hard cap of exactly 5 suggestions. The `[10]` in the payload LOOKS like a limit and is
 * ignored — [5], [10], [20], [50] all return 5. Budget keyword expansion around 5 children
 * per seed, not 10, and multiply through LOCALES instead.
 *
 * 🔴 The no-result case is the trap: a term with no suggestions returns
 * `[[null,["CAhKAggD"],...]]`, which is NOT null, so a naive `if (data === null)` check
 * passes and the following .map() throws. Hence the optional chaining below.
 */
export async function playSuggest(term, country = "us", language = "en") {
  const query = String(term).trim();
  if (!query) return [];

  const inner = JSON.stringify([[null, [query], [10], [2], 4]]);
  const freq = JSON.stringify([[["IJ4APc", inner]]]);

  // These stale 2019 session values still work — they are not validated.
  const url =
    "https://play.google.com/_/PlayStoreUi/data/batchexecute" +
    "?rpcids=IJ4APc&f.sid=-697906427155521722&bl=boq_playuiserver_20190903.08_p0" +
    `&hl=${language}&gl=${country}&authuser&soc-app=121&soc-platform=1&soc-device=1&_reqid=1065213`;

  const { text } = await fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `f.req=${encodeURIComponent(freq)}`,
    cacheKey: `ac:android:ij4apc:${country}:${normalizeTerm(query)}`,
    ttl: TTL.autocomplete,
  });

  try {
    const input = JSON.parse(text.substring(5)); // strip the )]}' prefix
    const data = JSON.parse(input[0][2]); // the payload is JSON inside a string — parse twice
    return (data?.[0]?.[0]?.map((s) => s[0]) ?? []).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Google Search's Play-scoped autocomplete — broader (up to 15) and noisier. Worth having
 * for keyword DISCOVERY breadth, where 15 candidates beat 5.
 *
 * The encoding is type-prefixed: "play/en&query@apps|alarm clock for free". Filter hard on
 * `query@apps|` — the apps/books mix is query-dependent ("motivation" returned 13 of 15 as
 * nav@books), so expect thin yields on book-ish terms.
 */
export async function playSuggestBroad(term, country = "us", language = "en") {
  const url =
    `https://www.google.com/complete/search?client=chrome&ds=play` +
    `&hl=${language}&gl=${country}&q=${encodeURIComponent(term)}`;

  const { data } = await fetchJson(url, {
    cacheKey: `ac:android:broad:${country}:${normalizeTerm(term)}`,
    ttl: TTL.autocomplete,
  });

  return (data?.[1] ?? [])
    .filter((s) => typeof s === "string" && s.includes("query@apps|"))
    .map((s) => s.split("|")[1])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 2. Ranked SERP — plain HTML beats batchexecute (02 §6.3)
// ---------------------------------------------------------------------------

/**
 * One fetch yields ~26 apps in TRUE ranked order. DOM order == the ds:4 payload order,
 * which makes the regex path more robust than batchexecute here.
 *
 * 🔴 Play search pagination is DEAD and it is structural: Google stopped emitting a
 * next-page token, so the ceiling is roughly 19-30 results per query. The deeper 250-result
 * path ran through managed Play (/work/search), which now 302s away and was removed from
 * google-play-scraper in v10.1.3. The library still documents a 250 cap; it is unreachable.
 *
 * Design consequence: FAN OUT across terms × locales. Never try to paginate one term on
 * Play. This differs sharply from Apple, where one call gives 250.
 */
export async function playSearchRanked(term, country = "us", language = "en") {
  const url =
    `https://play.google.com/store/search?q=${encodeURIComponent(term)}` +
    `&c=apps&hl=${language}&gl=${country}`;

  const { text } = await fetchText(url, {
    cacheKey: `serp:android:${country}:${normalizeTerm(term)}`,
    ttl: TTL.serp,
  });

  assertNotTruncated(text, `play search "${term}" (${country})`);

  // DOM order == the ds:4 payload order (verified), so the href scan gives true ranking.
  const seen = [];
  for (const m of text.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9_.]+)/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }

  return seen.map((pkg, i) => ({
    rank: i + 1,
    store_id: pkg,
    rating_average: ratingsFromSerp(text).get(pkg) ?? null,
  }));
}

/**
 * Ratings for every app in a Play SERP, without 26 extra detail fetches.
 *
 * Inside the ds:4 payload each app block opens with a `["<package>",7]` marker and its
 * rating appears later in the same block as a display/precise pair: `["4.3",4.265191]`.
 * So we pair positionally — each package takes the first rating that falls between its own
 * marker and the next one. Verified against the live payload on 2026-07-31.
 *
 * Memoised per response body: playSearchRanked would otherwise re-scan 1.2MB per row.
 */
const ratingCacheByLen = new Map();
function ratingsFromSerp(text) {
  const memo = ratingCacheByLen.get(text.length);
  if (memo && memo.sample === text.slice(0, 64)) return memo.map;

  const markers = [...text.matchAll(/\["([A-Za-z0-9_.]{3,}?)",7\]/g)].map((m) => ({ pkg: m[1], at: m.index }));
  const rated = [...text.matchAll(/\["(\d\.\d)",(\d+\.\d+)\]/g)].map((m) => ({ value: Number(m[2]), at: m.index }));

  const map = new Map();
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].at;
    const end = i + 1 < markers.length ? markers[i + 1].at : text.length;
    // An app with no ratings yet simply has no pair in its window → stays null, not 0.
    const hit = rated.find((r) => r.at > start && r.at < end);
    if (hit && !map.has(markers[i].pkg)) map.set(markers[i].pkg, Math.round(hit.value * 100) / 100);
  }

  ratingCacheByLen.set(text.length, { sample: text.slice(0, 64), map });
  if (ratingCacheByLen.size > 8) ratingCacheByLen.delete(ratingCacheByLen.keys().next().value);
  return map;
}

/**
 * 🔴 Play can return 200 OK carrying an error payload with TRUNCATED data — the nastiest of
 * its three failure modes, because a crawl that silently records 30 apps instead of 300
 * looks like a quiet day rather than a bug. Never trust the status code alone.
 */
function assertNotTruncated(body, what) {
  if (body.includes("PlayGatewayError") || body.includes("PlayDataError")) {
    throw new Error(`${what}: Play returned 200 with an error payload (PlayGatewayError/PlayDataError) — data is partial.`);
  }
  if (body.length < 20_000) {
    throw new Error(`${what}: response is only ${body.length} bytes; a real Play page is ~1.2MB. Treating as truncated.`);
  }
}

// ---------------------------------------------------------------------------
// 3. App detail (02 §6.5)
// ---------------------------------------------------------------------------

/** Pulls the AF_initDataCallback blocks out of a Play page, keyed ds:0 … ds:12. */
function initData(html) {
  const out = {};
  for (const m of html.matchAll(/AF_initDataCallback\((\{[\s\S]*?\})\);<\/script>/g)) {
    const keyMatch = m[1].match(/key:\s*'(ds:\d+)'/);
    const dataMatch = m[1].match(/data:([\s\S]*?), sideChannel:/);
    if (!keyMatch || !dataMatch) continue;
    try {
      out[keyMatch[1]] = JSON.parse(dataMatch[1]);
    } catch {
      /* one unparseable block must not lose the others */
    }
  }
  return out;
}

export async function playAppDetail(packageName, country = "us", language = "en") {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${language}&gl=${country}`;
  const { text } = await fetchText(url, {
    cacheKey: `detail:android:${country}:${packageName}`,
    ttl: TTL.appMetaAndroid,
    allow404: true,
  });
  if (!text) return null;

  const blocks = initData(text);
  // ds:5 is the documented root, but Google moves it; try the likely blocks in order.
  let root = null;
  for (const key of ["ds:5", "ds:4", "ds:6", "ds:3", "ds:7"]) {
    if (blocks[key] && at(blocks[key], PATHS.title)) { root = blocks[key]; break; }
  }
  if (!root) return null;

  const priceMicros = at(root, PATHS.priceMicros);
  const updatedUnix = at(root, PATHS.updated);

  return {
    store_id: packageName,
    platform: "android",
    name: at(root, PATHS.title) ?? null,
    summary: at(root, PATHS.summary) ?? null, // 80 chars, indexed
    description: at(root, PATHS.description) ?? null, // 4,000 chars, indexed — the competitor's strategy
    installs_bucketed: at(root, PATHS.installs) ?? null,
    // The exact number. 3.6× more informative than the bucketed string on the verified
    // example (360,532,190 vs "100,000,000+"), and parsing the bucket throws that away.
    real_installs: at(root, PATHS.realInstalls) ?? null,
    rating_average: at(root, PATHS.score) ?? null,
    rating_count: at(root, PATHS.ratings) ?? null,
    review_count: at(root, PATHS.reviews) ?? null,
    rating_histogram: normaliseHistogram(at(root, PATHS.histogram)),
    price_cents: typeof priceMicros === "number" ? Math.round(priceMicros / 10_000) : null,
    currency: at(root, PATHS.currency) ?? null,
    developer_name: at(root, PATHS.developer) ?? null,
    developer_id: at(root, PATHS.developerId) ?? null,
    primary_genre: at(root, PATHS.genre) ?? null,
    genre_id: at(root, PATHS.genreId) ?? null,
    content_rating: at(root, PATHS.contentRating) ?? null,
    released_at: at(root, PATHS.released) ?? null,
    version_released_at: typeof updatedUnix === "number" ? new Date(updatedUnix * 1000).toISOString() : null,
    icon_url: at(root, PATHS.icon) ?? null,
    screenshot_urls: (at(root, PATHS.screenshots) ?? []).map((s) => at(s, [3, 2])).filter(Boolean),
    is_free: !priceMicros,
  };
}

/** Play's histogram is [null,[n,1★],[n,2★],…]; return [5★,4★,3★,2★,1★] to match iOS. */
function normaliseHistogram(raw) {
  if (!Array.isArray(raw)) return null;
  const counts = [1, 2, 3, 4, 5].map((star) => at(raw, [star, 1]) ?? 0);
  return counts.reverse(); // 5★ first, matching appleAppSSR
}

/**
 * Play category ranking. The collection endpoint is JS-only and returns 0 apps; the category
 * page works and gives ~49.
 */
export async function playCategoryRanking(categoryId, country = "us", language = "en") {
  const { text } = await fetchText(
    `https://play.google.com/store/apps/category/${categoryId}?hl=${language}&gl=${country}`,
    { cacheKey: `charts:android:${country}:${categoryId}`, ttl: TTL.charts, allow404: true },
  );
  if (!text) return [];

  const seen = [];
  for (const m of text.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9_.]+)/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen.map((pkg, i) => ({ rank: i + 1, store_id: pkg }));
}

/**
 * Term frequency over a competitor's own Play listing text — the cheapest high-value
 * discovery source in the whole product, and Android-only (07 §4.1).
 *
 * Play indexes title + summary + description and all of it is public, so this IS the
 * competitor's keyword targeting. Apple has no equivalent: it uses a hidden 100-char field
 * and does not index the description at all.
 */
export function extractListingKeywords(detail, { max = 40, minLength = 4 } = {}) {
  const text = [detail?.name, detail?.summary, detail?.description].filter(Boolean).join(" ");
  if (!text) return [];

  const counts = new Map();
  const words = normalizeTerm(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= minLength && !STOPWORDS.has(w));

  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

  // Two-word phrases too — ASO targets are usually phrases, not single words.
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  const total = words.length || 1;
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([term, n]) => ({ term, count: n, frequency: Math.round((n / total) * 10000) / 10000 }));
}

const STOPWORDS = new Set(
  `the a an and or to of for in on at by with from as is are be been it its this that these those you your our their
   we they he she his her not no so if then than but also more most can will just now new get all any every out up
   down about into over under out off only own same too very what which who whom how when where why has have had do
   does did doing would should could may might must app apps free download install using use used using version
   android google play store` .split(/\s+/).filter(Boolean),
);
