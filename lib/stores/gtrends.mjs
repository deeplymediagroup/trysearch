/**
 * Google Trends — free, real, 5-year seasonality per search term.
 *
 * The unofficial-but-stable widget flow the Trends site itself uses:
 *   1. /trends/api/explore            → widget tokens (strip the `)]}'` XSSI prefix)
 *   2. /trends/api/widgetdata/multiline → the weekly interest timeline
 *
 * Rules honoured here: real data only (a failed fetch is null, never a guess), cached 7 days
 * in upstream_cache because Trends rate-limits aggressively.
 */

const BASE = "https://trends.google.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

function stripXssi(text) {
  return text.replace(/^\)\]\}'?,?\s*/, "");
}

let nidCookie = null;

/** Trends 429s the first anonymous hit while setting a NID cookie; the retry succeeds. */
async function trendsFetch(url) {
  const headers = nidCookie ? { ...HEADERS, Cookie: nidCookie } : HEADERS;
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    const setCookie = res.headers.get("set-cookie")?.split(";")[0];
    if (!setCookie) return res;
    nidCookie = setCookie;
    res = await fetch(url, { headers: { ...HEADERS, Cookie: nidCookie } });
  }
  return res;
}

/** Weekly interest points for the last 5 years, or null when Trends refuses. */
export async function interestOverTime(term, geo = "US") {
  const exploreReq = {
    comparisonItem: [{ keyword: term, geo, time: "today 5-y" }],
    category: 0,
    property: "",
  };
  const exploreUrl = `${BASE}/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(exploreReq))}`;
  const exploreRes = await trendsFetch(exploreUrl);
  if (!exploreRes.ok) return null;
  const explore = JSON.parse(stripXssi(await exploreRes.text()));
  const widget = explore?.widgets?.find((w) => w.id === "TIMESERIES");
  if (!widget?.token) return null;

  const dataUrl = `${BASE}/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const dataRes = await trendsFetch(dataUrl);
  if (!dataRes.ok) return null;
  const data = JSON.parse(stripXssi(await dataRes.text()));
  const points = data?.default?.timelineData;
  if (!Array.isArray(points) || points.length < 52) return null;

  return points
    .filter((p) => p.hasData?.[0] !== false)
    .map((p) => ({ time: Number(p.time) * 1000, value: Number(p.value?.[0] ?? 0) }));
}

/**
 * Pure seasonality computation over the weekly points: a 12-entry monthly index (100 = the
 * term's own average), peak months, and whether the swing is big enough to call seasonal.
 * Exported separately so it is testable without the network.
 */
export function seasonalityFromPoints(points) {
  if (!points || points.length < 52) return null;
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const p of points) byMonth[new Date(p.time).getUTCMonth()].push(p.value);
  if (byMonth.some((m) => m.length === 0)) return null;

  const monthAvg = byMonth.map((vals) => vals.reduce((s, v) => s + v, 0) / vals.length);
  const overall = monthAvg.reduce((s, v) => s + v, 0) / 12;
  if (overall <= 0) return null;

  const index = monthAvg.map((v) => Math.round((v / overall) * 100));
  const max = Math.max(...index);
  const min = Math.min(...index);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const peaks = index.map((v, i) => ({ month: MONTHS[i], v })).filter((m) => m.v >= 120).map((m) => m.month);
  const troughs = index.map((v, i) => ({ month: MONTHS[i], v })).filter((m) => m.v <= 80).map((m) => m.month);

  return {
    index, // Jan..Dec, 100 = this term's own average interest
    peaks,
    troughs,
    // ponytail: a fixed 1.5x max/min swing is "seasonal"; tune if it misfires in practice.
    seasonal: min > 0 ? max / min >= 1.5 : max >= 120,
    weeks: points.length,
  };
}

/** Fetch + compute + 7-day cache in upstream_cache. Returns null (never throws) on refusal. */
export async function keywordSeasonality(q1, term, geo = "US") {
  const key = `gtrends:${geo}:${term.toLowerCase()}`;
  const hit = await q1(`select payload from upstream_cache where cache_key = $1 and expires_at > now()`, [key]);
  if (hit) return hit.payload;

  let result = null;
  try {
    const points = await interestOverTime(term, geo);
    result = seasonalityFromPoints(points);
  } catch {
    result = null;
  }
  await q1(
    `insert into upstream_cache (cache_key, payload, expires_at) values ($1, $2, now() + interval '7 days')
     on conflict (cache_key) do update set payload = excluded.payload, expires_at = now() + interval '7 days'
     returning cache_key`,
    [key, JSON.stringify(result)],
  );
  return result;
}
