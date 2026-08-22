/**
 * Apple Ads — REAL search-term popularity, from the Apple Ads Platform API.
 *
 * History matters here. Apple's old Search Ads popularity (the 1–100 number every paid ASO
 * tool resold) COLLAPSED between 2025-09-29 and 2025-10-03. Apple's replacement, shipped with
 * the Apple Ads rebrand, is the Insights search-term-popularity dataset: for each country and
 * App Store genre, the top search terms with a real 1–100 popularity (country-wide AND
 * within-genre), plus the term's rank in its genre. Weekly (65 weeks of history) or monthly
 * (15 months). This module fetches it.
 *
 * That endpoint replaces the old SOV custom-report workaround this file used to carry
 * (async CSV reports, 10/day quota, 1–5 buckets mapped to invented midpoints). Real 1–100
 * values are what the proxy calibration in lib/scoring/scores.mjs was built to learn from —
 * bucket midpoints only ever polluted the fit.
 *
 * Auth is unchanged from the v5 era: ES256 client-secret JWT → OAuth2 token, scope
 * `searchadsorg`. Env: ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID, ASA_PRIVATE_KEY (PEM) or
 * ASA_PRIVATE_KEY_FILE, ASA_ORG_ID.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
// The Platform API host (Apple Ads rebrand), NOT the old api.searchads.apple.com/api/v5.
const ADS_API = "https://api.ads.apple.com/v1";

export function asaConfigured() {
  return Boolean(process.env.ASA_CLIENT_ID && process.env.ASA_TEAM_ID && process.env.ASA_KEY_ID && asaPrivateKey());
}

function asaPrivateKey() {
  if (process.env.ASA_PRIVATE_KEY) return process.env.ASA_PRIVATE_KEY;
  if (process.env.ASA_PRIVATE_KEY_FILE && fs.existsSync(process.env.ASA_PRIVATE_KEY_FILE)) {
    return fs.readFileSync(process.env.ASA_PRIVATE_KEY_FILE, "utf8");
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let cachedToken = null;

/** ES256 client-secret JWT → OAuth2 access token, cached until near expiry. */
export async function asaAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const clientId = process.env.ASA_CLIENT_ID;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: process.env.ASA_KEY_ID }));
  const payload = b64url(
    JSON.stringify({ sub: clientId, aud: "https://appleid.apple.com", iss: process.env.ASA_TEAM_ID, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: asaPrivateKey(), dsaEncoding: "ieee-p1363" });
  const clientSecret = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "searchadsorg",
    }),
  });
  if (!res.ok) throw new Error(`ASA token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return cachedToken.token;
}

async function adsPost(path, body) {
  const token = await asaAccessToken();
  const res = await fetch(`${ADS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Ap-Context": `orgId=${process.env.ASA_ORG_ID ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Apple Ads POST ${path} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * The last COMPLETE Sun–Sat week in UTC — the freshest period the weekly dataset can have.
 * A week that includes today is still being written, so a Saturday "today" uses the week
 * before. Exported for its test; off-by-one weeks silently fetch nothing.
 */
export function lastFullWeek(now = new Date(), weeksBack = 0) {
  const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceSaturday = (now.getUTCDay() + 1) % 7; // Sat→0(treated as 7), Sun→1, … Fri→6
  const end = d - ((sinceSaturday === 0 ? 7 : sinceSaturday) + weeksBack * 7) * 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(end - 6 * 86400000), end: iso(end) };
}

const STP_FIELDS = ["rankInGenre", "searchPopularityInGenre", "searchPopularity1to100", "searchPopularity1to5"];

/**
 * One page of POST /v1/insights/apps/search-term-popularity/query.
 * `genres` null → country-only (the full corpus across genres).
 */
async function stpPage({ country, genres, timeRange, offset, pageSize }) {
  const filters = [{ field: "countryOrRegion", operator: "EQUALS", value: String(country).toUpperCase() }];
  if (genres?.length) filters.push({ field: "genre", operator: "IN", value: genres });
  // No sorting block: Apple's default (genre ASC, rankInGenre ASC) is exactly what we want,
  // and the live API rejected `order` as an unrecognized property (verified 2026-08-22).
  return adsPost("/insights/apps/search-term-popularity/query", {
    filters,
    timeRange,
    fields: STP_FIELDS,
    pagination: { offset, pageSize },
  });
}

/**
 * Apple's search-term popularity corpus for one country: every row Apple publishes for the
 * last complete week (stepping back up to 2 weeks if the latest isn't out yet).
 *
 * Tries the whole country first; if Apple insists on a genre filter (400), retries with the
 * caller's genre list. Rows come back exactly as Apple names them: {week, countryOrRegion,
 * genre, searchTerm, rankInGenre, searchPopularityInGenre, searchPopularity1to100,
 * searchPopularity1to5}.
 *
 * `weeksBack` as a number fetches EXACTLY that week (for history backfill — Apple keeps 65
 * weekly periods); left null it steps back up to 2 weeks hunting for the latest published one.
 *
 * @returns {Promise<{rows: Array, period: string, truncated: boolean}>}
 */
export async function searchTermPopularity({ country, genres = [], maxPages = 4, pageSize = 5000, weeksBack: exactWeek = null } = {}) {
  const [firstWeek, lastWeek] = exactWeek == null ? [0, 2] : [exactWeek, exactWeek];
  for (let weeksBack = firstWeek; weeksBack <= lastWeek; weeksBack++) {
    const timeRange = { ...lastFullWeek(new Date(), weeksBack), granularity: "WEEKLY_SUN_SAT" };

    let filterGenres = null; // country-only first — one call covers every genre
    let rows = [];
    let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      let res;
      try {
        res = await stpPage({ country, genres: filterGenres, timeRange, offset: page * pageSize, pageSize });
      } catch (err) {
        // Apple rejected the country-only shape → scope to the caller's genres and restart.
        if (err.status === 400 && filterGenres == null && genres.length) {
          filterGenres = genres;
          rows = [];
          page = -1; // restart pagination
          continue;
        }
        throw err;
      }
      const pageRows = res?.result?.rows ?? res?.data?.rows ?? [];
      rows.push(...pageRows);
      const total = res?.pagination?.totalCount ?? res?.result?.pagination?.totalCount ?? null;
      if (pageRows.length < pageSize || (total != null && rows.length >= total)) break;
      if (page === maxPages - 1) truncated = true; // more exists than we fetched — say so
    }

    if (rows.length) return { rows, period: timeRange.start, truncated };
  }
  return { rows: [], period: null, truncated: false };
}

/**
 * Impression share for one of OUR apps: per search term, the share of available ad
 * impressions the app captured (as a low–high band; >90% is bucketed 0.91–1.0), our rank
 * among advertisers on that term, and Apple's 1–5 popularity. `promotedObjectId` is
 * REQUIRED by Apple and must be an app in the Apple Ads account — this endpoint cannot spy
 * on competitors. History is shallow by design (4 weekly periods), so rows must be
 * accumulated nightly, not backfilled.
 *
 * FIRST_SLOT is the report that matters for bidding: the top slot is where the ad money is.
 *
 * @returns {Promise<{rows: Array, period: string|null}>} rows as Apple names them:
 *   {week, appName, promotedObjectId, countryOrRegion, searchTerm, lowImpressionShare,
 *    highImpressionShare, rank, searchPopularity1to5}
 */
export async function impressionShare({ adamId, country, reportType = "FIRST_SLOT", pageSize = 5000 } = {}) {
  for (let weeksBack = 0; weeksBack <= 1; weeksBack++) {
    const { start, end } = lastFullWeek(new Date(), weeksBack);
    const res = await adsPost("/insights/apps/impression-share/query", {
      filters: [
        { field: "promotedObjectId", operator: "EQUALS", value: String(adamId) },
        { field: "countryOrRegion", operator: "EQUALS", value: String(country).toUpperCase() },
      ],
      options: { impressionShareReportType: reportType },
      timeRange: { start, end, granularity: "WEEKLY_SUN_SAT" }, // start MUST be a Sunday
      pagination: { offset: 0, pageSize },
    });
    const rows = res?.result?.rows ?? [];
    if (rows.length) return { rows, period: start };
  }
  return { rows: [], period: null };
}
