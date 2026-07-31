/**
 * The shared upstream fetch layer. Everything that talks to Apple or Google goes through
 * here — 07-CRAWLER-AND-JOBS.md §2.
 *
 * Written as .mjs, not .ts, deliberately: the crawler must stay a standalone script that
 * Brandon can run from his laptop with `node scripts/crawl.mjs` and no build step, while
 * the Next app imports the same functions for its interactive features. One implementation,
 * two consumers, zero transpile.
 *
 * What this layer guarantees:
 *   1. A GLOBAL token bucket per upstream host+endpoint class, not per job, so two
 *      concurrent jobs share one politeness budget.
 *   2. Adaptive backoff on 403/429 that honours Retry-After, doubles the delay, and
 *      recovers gradually on success — ported from aso-research.mjs, which has already
 *      survived contact with Apple's throttling.
 *   3. A 403-with-empty-body from Apple's /search is treated as a MULTI-MINUTE COOLDOWN,
 *      not a retryable blip. Retrying through it extends the block. The cooldown is scoped
 *      to that endpoint class alone, so it degrades one feature instead of halting the crawl.
 *   4. Every call is logged to fetch_log, so throttling is diagnosable instead of guessable.
 *   5. Reads and writes upstream_cache, so N callers asking the same question cost one call.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36 (+trysearch.app ASO research; contact deeplymediagroup@gmail.com)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate budgets per endpoint class, in requests per minute.
 *
 * These come from the LIVE MEASUREMENTS in 02-DATA-SOURCES.md §0 and §1.3, which are more
 * specific than the conservative table in 07 §2 and were taken on 2026-07-31:
 *   - itunes.apple.com/search is the ONLY Apple endpoint that genuinely throttles
 *     (~20-25/min, then 429, then a sticky empty-body 403).
 *   - /lookup took 151 calls at ~81/min with zero failures, measured WHILE /search was
 *     403ing the same client. Its block is endpoint-scoped, which is why these are
 *     separate buckets rather than one per host.
 *   - search.itunes.apple.com (autocomplete + the ranked SERP) took 40 calls in 21s with
 *     zero failures. The prefix-depth demand proxy spends up to 25 autocomplete calls per
 *     keyword, so a 10/min cap here would make the strongest signal in the product
 *     unaffordable. Set generously but still polite.
 * Every number is deliberately below what was measured as safe.
 */
const BUDGETS = {
  "itunes-search": 15, // the one that actually throttles — hard cap well under the limit
  "itunes-lookup": 60, // measured safe at ~81/min
  "itunes-rss": 30, // reviews + legacy charts; unaffected by the /search block
  "apple-storefront": 40, // search.itunes.apple.com: MZSearchHints + MZStore
  "apple-web": 20, // apps.apple.com SSR pages (~400KB each, so be gentle)
  play: 30, // 02 §6.6 advises 1-2 req/s; sit at the bottom of that
  other: 30,
};

/** Which bucket a URL belongs to. Endpoint-scoped, because Apple's blocks are. */
export function bucketFor(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.hostname === "itunes.apple.com") {
    if (u.pathname.startsWith("/search")) return "itunes-search";
    if (u.pathname.startsWith("/lookup")) return "itunes-lookup";
    return "itunes-rss";
  }
  if (u.hostname === "search.itunes.apple.com") return "apple-storefront";
  if (u.hostname === "apps.apple.com" || u.hostname === "rss.marketingtools.apple.com") return "apple-web";
  if (u.hostname.endsWith("play.google.com") || u.hostname.endsWith("www.google.com")) return "play";
  return "other";
}

/**
 * Per-bucket state. Module-level so it is genuinely global within a process — this is the
 * "one budget shared by all jobs" requirement.
 */
const state = new Map();
function bucket(name) {
  if (!state.has(name)) {
    state.set(name, {
      minIntervalMs: 60_000 / (BUDGETS[name] ?? BUDGETS.other),
      nextFreeAt: 0,
      backoffMs: 0, // grows on throttle, decays on success
      cooldownUntil: 0, // set by an empty-body 403: a multi-minute, endpoint-scoped block
      calls: 0,
      throttled: 0,
    });
  }
  return state.get(name);
}

/** Snapshot for the crawler's end-of-run report. */
export function fetchStats() {
  const out = {};
  for (const [name, b] of state) {
    out[name] = {
      calls: b.calls,
      throttled: b.throttled,
      backoff_ms: b.backoffMs,
      cooling_down: b.cooldownUntil > Date.now(),
    };
  }
  return out;
}

/**
 * The optional persistence seam. Both the crawler (pg Client) and the app (lib/db.ts) can
 * supply something with `query(sql, params)`; when nothing is supplied the fetch layer
 * still works, just without the ledger or the shared cache. That is what lets
 * scripts/smoke.mjs prove Gate 1 with NO credentials at all.
 */
let sink = null;
export function setFetchSink(db) {
  sink = db && typeof db.query === "function" ? db : null;
}

async function logFetch(url, status, durationMs, throttled) {
  if (!sink) return;
  try {
    const u = new URL(url);
    await sink.query(
      `insert into fetch_log (host, endpoint, country, status_code, duration_ms, throttled)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        u.hostname,
        u.pathname.slice(0, 120),
        u.searchParams.get("country") || u.searchParams.get("gl") || null,
        status,
        Math.round(durationMs),
        throttled,
      ],
    );
  } catch {
    // The ledger is diagnostics. Losing a log line must never fail a fetch.
  }
}

// ---------------------------------------------------------------------------
// Shared response cache (07 §3)
// ---------------------------------------------------------------------------

export const TTL = {
  serp: 20 * 3600, // until the next daily run
  autocomplete: 6 * 3600, // interactive: must feel live, cannot hammer Apple
  metrics: 7 * 86400, // popularity/difficulty move slowly
  appMetaIos: 24 * 3600,
  appMetaAndroid: 4 * 3600, // Play changes more often
  reviews: 24 * 3600,
  charts: 20 * 3600,
};

async function cacheGet(key) {
  if (!sink || !key) return null;
  try {
    const { rows } = await sink.query(
      `select payload from upstream_cache where cache_key = $1 and expires_at > now()`,
      [key],
    );
    return rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}

async function cachePut(key, payload, ttlSeconds) {
  if (!sink || !key || payload == null) return;
  try {
    await sink.query(
      `insert into upstream_cache (cache_key, payload, expires_at)
       values ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
       on conflict (cache_key) do update
         set payload = excluded.payload, expires_at = excluded.expires_at`,
      [key, JSON.stringify(payload), String(ttlSeconds)],
    );
  } catch {
    // A cache write failure is not a fetch failure.
  }
}

/** Purges expired rows. Called once per crawl so the table cannot grow without bound. */
export async function pruneCache() {
  if (!sink) return 0;
  try {
    const { rowCount } = await sink.query(`delete from upstream_cache where expires_at < now()`);
    return rowCount ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The fetch itself
// ---------------------------------------------------------------------------

/** Thrown when an endpoint class is in an Apple-imposed cooldown. Callers degrade, not die. */
export class CooldownError extends Error {
  constructor(bucketName, until) {
    super(`${bucketName} is in cooldown for another ${Math.ceil((until - Date.now()) / 1000)}s`);
    this.name = "CooldownError";
    this.bucket = bucketName;
    this.until = until;
    this.retryable = true;
  }
}

async function waitForSlot(b) {
  const now = Date.now();
  const readyAt = Math.max(b.nextFreeAt, now);
  // Claim the slot BEFORE awaiting, so concurrent callers queue instead of colliding.
  b.nextFreeAt = readyAt + b.minIntervalMs + b.backoffMs;
  if (readyAt > now) await sleep(readyAt - now);
}

/**
 * Fetch text through the politeness layer.
 *
 * @param {string} url
 * @param {object}  [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {string}  [opts.cacheKey]     enables the shared cache
 * @param {number}  [opts.ttl]          seconds
 * @param {number}  [opts.attempts=3]
 * @param {boolean} [opts.allow404]     return "" instead of throwing
 * @param {string}  [opts.method]
 * @param {string}  [opts.body]
 * @returns {Promise<{ text: string, cached: boolean, status: number }>}
 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, cacheKey, ttl = TTL.metrics, attempts = 3, allow404 = false, method = "GET", body } = opts;

  const hit = await cacheGet(cacheKey);
  if (hit && typeof hit.text === "string") return { text: hit.text, cached: true, status: 200 };

  const name = bucketFor(url);
  const b = bucket(name);

  if (b.cooldownUntil > Date.now()) throw new CooldownError(name, b.cooldownUntil);

  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForSlot(b);

    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers },
        redirect: "follow", // apps.apple.com/app/id{n} is a 301 to the slug URL
      });
    } catch (err) {
      // Network blip (DNS, reset). Retry with a short linear backoff.
      await logFetch(url, 0, Date.now() - started, false);
      if (attempt === attempts - 1) throw new Error(`network error for ${url.slice(0, 100)}: ${err.message}`);
      await sleep(600 * (attempt + 1));
      continue;
    }

    const durationMs = Date.now() - started;
    lastStatus = res.status;
    b.calls++;

    if (res.ok) {
      const text = await res.text();
      await logFetch(url, res.status, durationMs, false);
      // Decay the backoff on success rather than dropping it — recover gradually.
      b.backoffMs = Math.floor(b.backoffMs / 2);
      if (b.backoffMs < 50) b.backoffMs = 0;
      if (cacheKey) await cachePut(cacheKey, { text }, ttl);
      return { text, cached: false, status: res.status };
    }

    if (res.status === 404 && allow404) {
      await logFetch(url, 404, durationMs, false);
      return { text: "", cached: false, status: 404 };
    }

    if (res.status === 403 || res.status === 429) {
      b.throttled++;
      await logFetch(url, res.status, durationMs, true);

      const retryAfter = Number(res.headers.get("retry-after"));
      const emptyBody = res.headers.get("content-length") === "0" || (await res.text()).length === 0;

      // 02 §1.3: an empty-body 403 is the ESCALATION of 429 and persisted across 60
      // consecutive requests. Treat it as a multi-minute, endpoint-scoped cooldown.
      if (res.status === 403 && emptyBody) {
        b.cooldownUntil = Date.now() + 5 * 60_000;
        b.backoffMs = Math.min(Math.max(b.backoffMs * 2, 2000), 15_000);
        throw new CooldownError(name, b.cooldownUntil);
      }

      b.backoffMs = Math.min(Math.max(b.backoffMs * 2, 900), 15_000);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : b.backoffMs * 2;
      if (attempt === attempts - 1) {
        // Out of attempts: cool this bucket down so the next caller does not walk into it.
        b.cooldownUntil = Date.now() + 60_000;
        throw new CooldownError(name, b.cooldownUntil);
      }
      await sleep(waitMs);
      continue;
    }

    // 5xx and anything else: retry a couple of times, then surface honestly.
    await logFetch(url, res.status, durationMs, false);
    if (attempt === attempts - 1) throw new Error(`HTTP ${res.status} for ${url.slice(0, 100)}`);
    await sleep(800 * (attempt + 1));
  }

  throw new Error(`gave up after ${attempts} attempts (last status ${lastStatus}) for ${url.slice(0, 100)}`);
}

/** Same, parsed as JSON. */
export async function fetchJson(url, opts = {}) {
  const { text, cached, status } = await fetchText(url, opts);
  if (!text) return { data: null, cached, status };
  try {
    return { data: JSON.parse(text), cached, status };
  } catch {
    // A parse failure must be loud: writing a "checked and absent" row when the truth is
    // "we could not parse it" is the exact bug 07 §9 warns about.
    throw new Error(`unparseable JSON from ${url.slice(0, 100)} (${text.length} bytes, starts "${text.slice(0, 60)}")`);
  }
}

/**
 * Extracts the serialized-server-data blob every apps.apple.com page embeds.
 * 02 §8.4 — this replaces the closed amp-api entirely and needs no token.
 */
export function serializedServerData(html) {
  const m = html.match(/<script type="application\/json" id="serialized-server-data">(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** XML plist entity decode — Apple's autocomplete returns escaped terms. */
export const decodeXml = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

/** Normalises a keyword for the (term_normalized, platform, country) unique key. */
export function normalizeTerm(term) {
  return String(term).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
