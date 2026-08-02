/**
 * The one Apple client. Merged from Brandon's three independent implementations
 * (10-REUSE-EXISTING-CODE.md §3):
 *   - base client + adaptive backoff + storefront map ← aso-research.mjs
 *   - top charts + the IAP price scraper             ← idea-command-center/pipeline/ingest/itunes.ts
 *   - the serialized-server-data parse               ← the same file's scrapeIap()
 *
 * Every endpoint here is free and unauthenticated. Nothing in this file needs a credential.
 *
 * The two that do the heavy lifting are undocumented by Apple:
 *   MZStore.woa/wa/search       → a 250-deep, TRUE store-ranked SERP, with subtitles
 *   serialized-server-data      → the subtitle, the full 5-star histogram, 200-deep charts
 */
import { fetchJson, fetchText, serializedServerData, decodeXml, TTL, normalizeTerm } from "./http.mjs";
import { storefrontId } from "./storefronts.mjs";

const SEARCH_HOST = "https://search.itunes.apple.com/WebObjects";

// ---------------------------------------------------------------------------
// 1. Autocomplete — MZSearchHints (02 §2)
// ---------------------------------------------------------------------------

/**
 * Apple's own ordered suggestions for a prefix. THE ORDER IS THE DEMAND SIGNAL.
 *
 * Hard facts encoded here:
 *   - Exactly 10 hints, hard cap. maxHints/limit/n/numResults are all ignored.
 *   - Returns an XML plist only; no JSON variant exists.
 *   - clientApplication=Software is mandatory: MacSoftware/iTunes return a different corpus
 *     ("alarm" → alarm.com rather than alarm sounds).
 *   - The `priority` integer (Apple's own popularity number) was REMOVED in 2022. Only
 *     `term` and `url` come back now, which is why the popularity proxy exists at all.
 *   - An empty result means "you called it wrong", not "no suggestions".
 *
 * @returns {Promise<string[]>} up to 10 terms, in Apple's popularity order
 */
export async function appleAutocomplete(prefix, country = "us", { cache = true } = {}) {
  const term = String(prefix).trim();
  if (!term) return []; // empty term → empty array; there is no trending mode

  const url =
    `${SEARCH_HOST}/MZSearchHints.woa/wa/hints` +
    `?clientApplication=Software&media=software&term=${encodeURIComponent(term)}`;

  const { text } = await fetchText(url, {
    headers: { "X-Apple-Store-Front": `${storefrontId(country)},29` },
    cacheKey: cache ? `ac:ios:${country}:${normalizeTerm(term)}` : undefined,
    ttl: TTL.autocomplete,
  });

  // <key> and <string> sit on separate lines, so the regex must span them. Matching the
  // PAIR (not every <string>) matters — otherwise you collect urls and the word "Suggestions".
  return [...text.matchAll(/<key>term<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => decodeXml(m[1]));
}

/**
 * The prefix-depth demand proxy (02 §9.3, 03 §1.2) — the strongest free demand signal
 * available, and the replacement for Apple's dead `priority` field.
 *
 * Walks prefixes of the keyword from 1 character upward and records at what prefix length
 * the exact term first appears in autocomplete, and at what position. An earlier reveal
 * means higher demand: "motivational quotes" reveals at 6 characters, while
 * "alarm clock for heavy sleepers" needs 13.
 *
 * Costs at most 25 calls, on the host measured as unthrottled. Also surfaced directly to
 * the user as the "Keyword reveal" feature on /autocomplete — built once, used twice.
 *
 * @returns {Promise<{length: number|null, index: number|null, best: number|null, hits: number}>}
 */
export async function suggestDepth(term, country = "us", platform = "ios", opts = {}) {
  const target = normalizeTerm(term);
  const maxLen = Math.min(target.length, 25);
  const suggest = platform === "android" ? opts.playSuggest : null;

  let best = null; // best position seen at ANY prefix length
  let hits = 0; // how many distinct prefixes surfaced the term
  let firstLength = null;
  let firstIndex = null;

  for (let length = 1; length <= maxLen; length++) {
    const prefix = target.slice(0, length);
    let hintList;
    try {
      hintList = suggest ? await suggest(prefix, country) : await appleAutocomplete(prefix, country);
    } catch {
      continue; // one bad prefix must not abandon the whole walk
    }
    const index = hintList.findIndex((h) => normalizeTerm(h) === target);
    if (index === -1) continue;

    hits++;
    if (best === null || index < best) best = index;
    if (firstLength === null) {
      firstLength = length;
      firstIndex = index;
      // Keep walking a few more prefixes to measure breadth, but not all 25 — the reveal
      // point is the expensive part and we already have it.
      if (!opts.fullBreadth) {
        for (let extra = length + 1; extra <= Math.min(length + 3, maxLen); extra++) {
          try {
            const more = suggest ? await suggest(target.slice(0, extra), country) : await appleAutocomplete(target.slice(0, extra), country);
            const i2 = more.findIndex((h) => normalizeTerm(h) === target);
            if (i2 !== -1) {
              hits++;
              if (i2 < best) best = i2;
            }
          } catch {
            /* ignore */
          }
        }
        break;
      }
    }
  }

  // Never suggested at any prefix length → null, NOT zero. We did not observe it, which is
  // different from observing that nobody searches it (03 §1.2).
  return { length: firstLength, index: firstIndex, best, hits };
}

// ---------------------------------------------------------------------------
// 2. The ranked SERP — MZStore.woa/wa/search (02 §3). The rank-tracking primitive.
// ---------------------------------------------------------------------------

/**
 * A 250-deep, TRUE store-ranked SERP. Free, unauthenticated, and measured at 25 rapid calls
 * with zero failures.
 *
 * `t:native` in the storefront header is LOAD-BEARING, not decoration: it is what turns
 * platform 24 from useless HTML into flat JSON.
 *
 * Returns 250 ordered ids plus the 8 apps Apple hydrates — and the hydrated objects include
 * `subtitle`, which the iTunes Search API does not expose at all. (Trick: to read any app's
 * subtitle at any rank, search its exact name; it lands in the hydrated 8.)
 *
 * Do NOT substitute itunes.apple.com/search here. The two disagree — top-10 matches only
 * 8/10 and top-50 overlap is just 30/50. MZStore is the real store ranking.
 *
 * @returns {Promise<{ids: string[], hydrated: object[], totalCount: number, storeFront: string|null, language: string|null}>}
 */
export async function appleSearchRanked(term, country = "us", { cache = true } = {}) {
  const url =
    `${SEARCH_HOST}/MZStore.woa/wa/search` +
    `?clientApplication=Software&media=software&term=${encodeURIComponent(term)}`;

  const sf = storefrontId(country);
  const { data } = await fetchJson(url, {
    headers: {
      "X-Apple-Store-Front": `${sf},24 t:native`,
      "Accept-Language": "en-us",
    },
    cacheKey: cache ? `serp:ios:${country}:${normalizeTerm(term)}` : undefined,
    ttl: TTL.serp,
  });

  if (!data) return { ids: [], hydrated: [], totalCount: 0, storeFront: null, language: null };

  // Platform 24 + t:native puts these at the top level; ,29/,26 nest them under pageData.
  const bubbles = data.bubbles ?? data.pageData?.bubbles ?? [];
  const software = bubbles.find((b) => b?.name === "software") ?? bubbles[0] ?? {};
  const ids = (software.results ?? []).map((r) => String(r.id)).filter(Boolean);

  const platformData = data.storePlatformData ?? data.pageData?.storePlatformData ?? {};
  const lockup = platformData["native-search-lockup-search"] ?? platformData["native-search-lockup"] ?? {};
  const hydrated = Object.values(lockup.results ?? {});

  // 02 §3.3: Apple echoes back which store it ACTUALLY served. Log it on every SERP fetch —
  // it catches header mistakes that would otherwise return US data labelled as another
  // country, a class of bug that is nearly invisible and poisons every downstream metric.
  const metrics = data.metricsBase ?? data.pageData?.metricsBase ?? {};

  return {
    ids,
    hydrated: hydrated.map(hydratedApp),
    totalCount: software.totalCount ?? ids.length,
    storeFront: metrics.storeFront ?? null,
    language: metrics.language ?? null,
    requestedStoreFront: String(sf),
  };
}

/** Normalises one hydrated MZStore app object. `subtitle` is the prize here. */
function hydratedApp(a) {
  const offer = (a.offers ?? [])[0] ?? {};
  return {
    store_id: String(a.id),
    name: a.name ?? a.nameRaw ?? null,
    subtitle: a.subtitle ?? null, // absent from the iTunes API at any price
    bundle_id: a.bundleId ?? null,
    developer_id: a.artistId ? String(a.artistId) : null,
    developer_name: a.artistName ?? null,
    icon_url: a.artwork?.url ? artworkUrl(a.artwork.url, 100) : null,
    genres: (a.genreNames ?? []).filter(Boolean),
    // userRating.value here is ROUNDED to 0.5. Use /lookup when precision matters.
    rating_average: a.userRating?.value ?? null,
    rating_count: a.userRating?.ratingCount ?? null,
    price_cents: typeof offer.price === "number" ? Math.round(offer.price * 100) : null,
    currency: offer.currencyCode ?? null,
    has_iap: a.hasInAppPurchases ?? null,
    released_at: a.releaseDate ?? null,
  };
}

/** Apple artwork templates carry {w}x{h}{c}.{f} placeholders. */
function artworkUrl(template, size = 100) {
  return String(template).replace("{w}", size).replace("{h}", size).replace("{c}", "bb").replace("{f}", "png");
}

// ---------------------------------------------------------------------------
// 3. Metadata — iTunes Lookup (02 §1). Batch 200; effectively unthrottled.
// ---------------------------------------------------------------------------

/**
 * Hydrates ids into full app records. 200 ids per call, verified.
 *
 * This endpoint is the workhorse: 151 uncached calls at ~81/min with zero failures,
 * measured WHILE /search was 403ing the same client. Combined with 200-id batching that is
 * ~16,000 app records per minute. NEVER use /search for ids you already have.
 *
 * Caps worth knowing: the hard RESULT cap is 210 regardless of what you ask for; 400 ids
 * returns HTTP 502 and ~767 ids returns HTTP 400 (URL length). Hence chunks of 200.
 *
 * @param {string[]} ids numeric trackIds
 * @param {string} country
 * @param {object} [opts]
 * @param {boolean} [opts.english] send lang=en_us to normalise a multi-country crawl to
 *   English. `lang` is functionally BINARY — only en_us does anything; any other value
 *   returns the storefront's native language.
 * @param {boolean} [opts.cache] read/write the shared upstream_cache
 * @param {boolean} [opts.bundleId] treat `ids` as reverse-DNS bundle ids instead of trackIds
 */
export async function appleLookup(ids, country = "us", { english = false, cache = true, bundleId = false } = {}) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const out = [];

  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    // Same endpoint, different key: `bundleId=` resolves a reverse-DNS bundle id, which is
    // what a teammate has when they paste an id out of Xcode rather than out of a URL.
    const url =
      `https://itunes.apple.com/lookup?${bundleId ? "bundleId" : "id"}=${batch.join(",")}` +
      `&country=${country}&entity=software&version=2` + // version=1 returns resultCount:0 for software
      (english ? "&lang=en_us" : "");

    const { data } = await fetchJson(url, {
      cacheKey: cache ? `lookup:${country}:${english ? "en" : "native"}:${bundleId ? "bundle:" : ""}${batch[0]}:${batch.length}` : undefined,
      ttl: TTL.appMetaIos,
    });
    for (const r of data?.results ?? []) {
      // A developer lookup returns a leading wrapperType:"artist" row — skip non-apps.
      if (r.wrapperType !== "software" || !r.trackId) continue;
      out.push(lookupApp(r));
    }
  }
  return out;
}

function lookupApp(r) {
  return {
    store_id: String(r.trackId),
    platform: "ios",
    name: r.trackName ?? null,
    bundle_id: r.bundleId ?? null,
    developer_id: r.artistId ? String(r.artistId) : null,
    developer_name: r.sellerName ?? r.artistName ?? null,
    icon_url: r.artworkUrl100 ?? r.artworkUrl512 ?? r.artworkUrl60 ?? null,
    primary_genre: r.primaryGenreName ?? null,
    genres: r.genres ?? [],
    price_cents: typeof r.price === "number" ? Math.round(r.price * 100) : null,
    currency: r.currency ?? null,
    content_rating: r.trackContentRating ?? r.contentAdvisoryRating ?? null,
    version: r.version ?? null,
    released_at: r.releaseDate ?? null,
    version_released_at: r.currentVersionReleaseDate ?? null,
    is_free: (r.price ?? 0) === 0,
    // averageUserRating from /lookup is PRECISE (4.7); MZStore rounds to 0.5.
    rating_average: typeof r.averageUserRating === "number" ? Math.round(r.averageUserRating * 100) / 100 : null,
    rating_count: r.userRatingCount ?? null,
    description: r.description ?? null,
    release_notes: r.releaseNotes ?? null,
    screenshot_urls: r.screenshotUrls ?? [],
    seller_url: r.sellerUrl ?? null, // present in only ~95/100 apps — guard it
    // NOTE: subtitle, promotionalText and the keywords field are all ABSENT here.
    // Subtitle comes from MZStore or the SSR page; the other two are not free anywhere.
  };
}

/**
 * Text search for apps, for "Find my app" where we have a name rather than an id.
 * Metadata only — never use this for ranking (see appleSearchRanked).
 *
 * `resultCount` from this endpoint is NOT a competition signal: it saturates against the
 * 200-row ceiling ("game" 188 vs "zen breathing timer app" 178 differ by noise, not by real
 * corpus size), which is exactly why the difficulty formula has no depth component.
 */
export async function appleSearch(term, country = "us", limit = 25) {
  const url =
    `https://itunes.apple.com/search?media=software&entity=software&version=2` +
    `&limit=${Math.min(limit, 200)}&country=${country}&term=${encodeURIComponent(term)}`;
  const { data } = await fetchJson(url, {
    cacheKey: `search:ios:${country}:${normalizeTerm(term)}:${limit}`,
    ttl: TTL.appMetaIos,
  });
  return (data?.results ?? []).filter((r) => r.trackId).map(lookupApp);
}

// ---------------------------------------------------------------------------
// 4. The SSR page — the best free source (02 §8.4)
// ---------------------------------------------------------------------------

/**
 * The subtitle and the FULL 5-star rating histogram, neither of which is available anywhere
 * else for free. Also similar apps WITH their subtitles, which makes it a discovery source.
 *
 * Needs a browser User-Agent and redirect-following: a bare request to /app/id{id} returns
 * a 0-byte 301. (The fetch layer follows redirects by default.)
 *
 * Ratings here are also FRESHER than the iTunes API — 29,325,949 vs 29,325,511 on the same
 * app in the same minute.
 */
export async function appleAppSSR(appId, country = "us", { cache = true } = {}) {
  const url = `https://apps.apple.com/${country}/app/id${appId}`;
  const { text } = await fetchText(url, {
    cacheKey: cache ? `ssr:app:${country}:${appId}` : undefined,
    ttl: TTL.appMetaIos,
    allow404: true,
  });
  if (!text) return null;

  const blob = serializedServerData(text);
  const root = blob?.data?.[0]?.data;
  if (!root) return null;

  const shelf = root.shelfMapping ?? {};
  const ratings = shelf.productRatings?.items?.[0] ?? null;
  const version = shelf.mostRecentVersion?.items?.[0] ?? null;

  return {
    store_id: String(root.lockup?.adamId ?? appId),
    name: root.lockup?.title ?? null,
    subtitle: root.lockup?.subtitle ?? null, // 30 chars, FULLY keyword-indexed
    bundle_id: root.lockup?.bundleId ?? null,
    description: shelf.description?.items?.[0]?.paragraph?.text ?? null,
    rating_average: ratings?.ratingAverage ?? null,
    rating_count: ratings?.totalNumberOfRatings ?? null,
    // [5★, 4★, 3★, 2★, 1★] — unobtainable free anywhere else.
    // Apple derives these from percentages, so they arrive as floats: a real response
    // contained 12.000000000000002. Round, or the UI renders a nonsense rating count.
    rating_histogram: Array.isArray(ratings?.ratingCounts)
      ? ratings.ratingCounts.map((n) => Math.round(Number(n) || 0))
      : null,
    release_notes: version?.text ?? null,
    version: version?.primarySubtitle ?? null,
    version_date: version?.secondarySubtitle ?? null,
    similar_apps: (shelf.similarItems?.items ?? []).map((i) => ({
      store_id: String(i.adamId ?? ""),
      bundle_id: i.bundleId ?? null,
      name: i.title ?? null,
      subtitle: i.subtitle ?? null,
    })).filter((a) => a.store_id),
    more_by_developer: (shelf.moreByDeveloper?.items ?? []).map((i) => ({
      store_id: String(i.adamId ?? ""),
      name: i.title ?? null,
      subtitle: i.subtitle ?? null,
    })).filter((a) => a.store_id),
    reviews: (shelf.allProductReviews?.items ?? []).map((i) => ({
      store_review_id: String(i.review?.id ?? ""),
      title: i.review?.title ?? null,
      body: i.review?.contents ?? null,
      rating: i.review?.rating ?? null,
      reviewed_at: i.review?.date ?? null,
    })).filter((r) => r.store_review_id),
    // promotionalText is NOT retrievable — the page requests extend=customPromotionalText
    // but nothing comes back. Apple folds it into the description on the storefront.
  };
}

/**
 * 200 ranked apps per chart per genre in ONE request (02 §8.4.2) — double the legacy RSS
 * and the Marketing Tools feed, and with the genre filtering neither of those supports.
 *
 * 25 apps arrive hydrated in shelves[0].items, then 175 more ids in nextPage.remainingContent,
 * all in rank order.
 */
export async function appleChartsSSR(country = "us", genreId = 36, slug = "top-apps") {
  const path = genreId === 36 ? `${country}/charts/iphone` : `${country}/charts/iphone/${slug}/${genreId}`;
  const { text } = await fetchText(`https://apps.apple.com/${path}`, {
    cacheKey: `ssr:charts:${country}:${genreId}`,
    ttl: TTL.charts,
    allow404: true,
  });
  if (!text) return { charts: [], categories: [] };

  const root = serializedServerData(text)?.data?.[0]?.data;
  if (!root) return { charts: [], categories: [] };

  // The root chart nests one level deeper: data.charts[0] = Apps, charts[1] = Games.
  const groups = root.charts ?? [{ genreId: root.genreId, segments: root.segments }];
  const charts = [];

  for (const group of groups) {
    for (const segment of group.segments ?? []) {
      const hydrated = (segment.shelves?.[0]?.items ?? []).map((i, idx) => ({
        rank: idx + 1,
        store_id: String(i.adamId ?? i.id ?? ""),
        name: i.title ?? null,
        subtitle: i.subtitle ?? null,
      }));
      const rest = (segment.nextPage?.remainingContent ?? []).map((i, idx) => ({
        rank: hydrated.length + idx + 1,
        store_id: String(i.id ?? ""),
        name: null,
        subtitle: null,
      }));
      charts.push({
        chart: segment.chart ?? null, // "top-free" | "top-paid"
        genre_id: String(group.genreId ?? genreId),
        entries: [...hydrated, ...rest].filter((e) => e.store_id),
      });
    }
  }

  return {
    charts,
    // Prefer this LIVE category list over any hardcoded map — it stays current on its own.
    categories: (root.categories ?? []).map((c) => ({ name: c.name, genre_id: String(c.genreId) })),
  };
}

/**
 * Top-grossing chart. The legacy RSS is the ONLY free grossing chart anywhere — the web
 * storefront exposes no grossing chart and Marketing Tools 404s on top-grossing.
 *
 * `limit` now caps at 100, not 200 (limit=101 and limit=200 both return 100), despite
 * app-store-scraper permitting num up to 200.
 */
export async function appleChartsRSS(country = "us", genreId = null, feedType = "topgrossingapplications", limit = 100) {
  const genre = genreId ? `genre=${genreId}/` : "";
  const url = `https://itunes.apple.com/${country}/rss/${feedType}/limit=${Math.min(limit, 100)}/${genre}json`;
  const { data } = await fetchJson(url, { cacheKey: `rss:${feedType}:${country}:${genreId ?? "all"}`, ttl: TTL.charts, allow404: true });
  const entries = ensureArray(data?.feed?.entry);
  return entries
    .map((e, i) => ({
      rank: i + 1,
      store_id: e?.id?.attributes?.["im:id"] ?? null,
      name: e?.["im:name"]?.label ?? null,
      developer_name: e?.["im:artist"]?.label ?? null,
    }))
    .filter((e) => e.store_id);
}

// ---------------------------------------------------------------------------
// 5. Reviews RSS (02 §4)
// ---------------------------------------------------------------------------

/**
 * Customer reviews. 50 per page, 10 pages max = 500 per country (page=11 returns HTTP 400).
 * Each country is its own 500-review pool, so iterate storefronts to go deeper.
 *
 * Three edge states that crash a naive parser, all handled:
 *   - entry[0] is often the APP ITSELF, not a review → filter on the presence of im:rating
 *   - an app with NO reviews returns 200 with no `entry` key at all → guard absence
 *   - an app with exactly ONE review returns `entry` as an OBJECT, not an array → ensureArray
 *
 * sortby accepts ONLY mostrecent and mosthelpful; anything else is HTTP 500.
 * This endpoint lives on itunes.apple.com but is NOT affected by the /search throttle.
 */
export async function appleReviews(appId, country = "us", page = 1, sortBy = "mostrecent") {
  if (!["mostrecent", "mosthelpful"].includes(sortBy)) {
    throw new Error(`appleReviews: sortby="${sortBy}" returns HTTP 500. Use mostrecent or mosthelpful.`);
  }
  const safePage = Math.min(Math.max(page, 1), 10); // page=11 is a hard 400
  const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${safePage}/id=${appId}/sortby=${sortBy}/json`;

  const { data } = await fetchJson(url, {
    cacheKey: `reviews:${country}:${appId}:${safePage}:${sortBy}`,
    ttl: TTL.reviews,
    allow404: true,
  });

  const entries = ensureArray(data?.feed?.entry);
  const reviews = entries
    .filter((e) => e?.["im:rating"]?.label) // drops the app-itself row
    .map((e) => ({
      store_review_id: String(e.id?.label ?? ""),
      rating: parseInt(e["im:rating"].label, 10),
      title: e.title?.label ?? null,
      body: e.content?.label ?? null, // .label on the /json variant, NOT content[0].label
      author: e.author?.name?.label ?? null,
      app_version: e["im:version"]?.label ?? null,
      helpful_count: e["im:voteSum"]?.label ? parseInt(e["im:voteSum"].label, 10) : null,
      reviewed_at: e.updated?.label ?? null,
    }))
    .filter((r) => r.store_review_id && Number.isFinite(r.rating));

  // Read the real last page from the feed instead of guessing at it.
  const lastLink = ensureArray(data?.feed?.link).find((l) => l?.attributes?.rel === "last");
  const lastPage = lastLink ? Number(lastLink.attributes.href.match(/page=(\d+)/)?.[1] ?? safePage) : safePage;

  return { reviews, page: safePage, last_page: Math.min(lastPage || safePage, 10) };
}

// ---------------------------------------------------------------------------
// 6. In-app purchase prices (10 §2) — turns a revenue guess into a priced model
// ---------------------------------------------------------------------------

/**
 * Parses a storefront-printed price into cents plus its currency.
 *
 * Handles the two decimal conventions Apple prints — "1,234.56" (US/UK) and "1.234,56" (EU) —
 * by treating whichever separator appears LAST as the decimal point. Returns null when the
 * string is not a price, so a non-price textPair is skipped rather than becoming 0 cents.
 */
const CURRENCY_SYMBOLS = [
  ["£", "GBP"], ["€", "EUR"], ["¥", "JPY"], ["₩", "KRW"], ["₹", "INR"],
  ["R$", "BRL"], ["A$", "AUD"], ["CA$", "CAD"], ["NZ$", "NZD"], ["$", "USD"],
];

export function parseStorePrice(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let currency = null;
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (s.includes(symbol)) { currency = code; break; }
  }
  if (!currency) return null; // no currency marker: not a price

  const digits = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    normalized = digits;                                  // "6000" (JPY/KRW have no minor unit)
  } else if (lastComma > lastDot) {
    normalized = digits.replace(/\./g, "").replace(",", ".");  // "1.234,56" -> "1234.56"
  } else {
    normalized = digits.replace(/,/g, "");                // "1,234.56" -> "1234.56"
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return { priceCents: Math.round(value * 100), currency };
}

const PERIOD_RX = [
  [/\bweek|7[- ]?day|wk\b/i, "week"],
  [/\bmonth|30[- ]?day|\bmo\b/i, "month"],
  [/\byear|annual|12[- ]?month|\byr\b/i, "year"],
  [/\blifetime|forever|one[- ]?time|permanent|unlimited access\b/i, "lifetime"],
];

/**
 * Real IAP names and prices, scraped from the store page's serialized-server-data blob.
 * Ported from idea-command-center/pipeline/ingest/itunes.ts, which already does this well.
 */
export async function appleInAppPurchases(appId, country = "us") {
  const { text } = await fetchText(`https://apps.apple.com/${country}/app/id${appId}`, {
    cacheKey: `ssr:app:${country}:${appId}`, // shares appleAppSSR's cache entry — one fetch, two uses
    ttl: TTL.appMetaIos,
    allow404: true,
  });
  if (!text || text.length < 5000) return [];

  const blob = serializedServerData(text);
  if (!blob) return [];

  const flat = JSON.stringify(blob);
  // The price is whatever the storefront prints — "$49.99", "£49.99", "49,99 €", "¥6,000".
  // The old pattern demanded a literal "$", so every non-US storefront returned ZERO in-app
  // purchases and the caller could not tell "this app has none" from "we cannot read this page".
  // Capture the whole trailing string and parse it below instead.
  const pairs = [
    ...flat.matchAll(/\{"\$kind":"textPair","leadingText":"((?:[^"\\]|\\.)*)","trailingText":"([^"\\]{2,24})"\}/g),
  ];

  const seen = new Set();
  const out = [];
  for (const m of pairs) {
    const name = m[1].replace(/\\"/g, '"');
    const money = parseStorePrice(m[2]);
    if (!money) continue; // a textPair whose trailing side is not a price at all
    const { priceCents, currency } = money;
    const key = `${name}|${priceCents}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let period = null;
    for (const [rx, p] of PERIOD_RX) if (rx.test(name)) { period = p; break; }
    const isSub = period === "week" || period === "month" || period === "year";

    out.push({
      name,
      price_cents: priceCents,
      currency,
      is_subscription: isSub,
      period,
      annualised_cents: annualiseCents(priceCents, period),
    });
  }
  return out;
}

export function annualiseCents(priceCents, period) {
  switch (period) {
    case "week": return priceCents * 52;
    case "month": return priceCents * 12;
    case "year": return priceCents;
    default: return null; // lifetime/unknown are excluded from the median
  }
}

// ---------------------------------------------------------------------------

/** Apple's JSON feeds return a bare object when there is exactly one element. */
export function ensureArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Does this app's name contain every word of the query? Drives the titleMatch component. */
export function titleMatches(appName, term) {
  const name = normalizeTerm(appName ?? "");
  if (!name) return false;
  const words = normalizeTerm(term).split(" ").filter(Boolean);
  // Word-wise, not substring: Apple tokenises, so "recipes" must not cover "recipe".
  const bag = new Set(name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return words.every((w) => bag.has(w));
}
