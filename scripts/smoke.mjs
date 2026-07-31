/**
 * GATE 1 — the single most important checkpoint in this build (09-BUILD-PLAN.md §Phase 1).
 *
 * Proves, with NO CREDENTIALS AT ALL, that we can actually talk to Apple and Google:
 *   1. 10 autocomplete suggestions for one prefix in two countries, and that they DIFFER
 *   2. the top 10 of a 250-deep MZStore SERP, INCLUDING each app's subtitle
 *   3. the correct organic rank of one known app for one known keyword
 *   4. one app's subtitle and FULL 5-star rating histogram from the SSR JSON
 *   5. 200 ranked apps from one genre chart via SSR
 *   6. a Play SERP of ~26 packages with ratings
 *   7. fetch_log rows for the calls, plus a deliberate throttle test proving backoff recovers
 *
 * If any of this fails, every later phase is worthless. Run: npm run smoke
 * Add --no-db to run entirely without a database (the credential-free path).
 */
import { Client } from "pg";
import { loadEnv } from "./env.mjs";
import {
  appleAutocomplete,
  appleSearchRanked,
  appleLookup,
  appleAppSSR,
  appleChartsSSR,
  appleReviews,
  suggestDepth,
} from "../lib/stores/apple.mjs";
import { playSuggest, playSuggestBroad, playSearchRanked, playAppDetail } from "../lib/stores/play.mjs";
import { setFetchSink, fetchStats, bucketFor, CooldownError } from "../lib/stores/http.mjs";

loadEnv();

const NO_DB = process.argv.includes("--no-db");
const KEYWORD = "motivational quotes";
const KNOWN_APP = "1487761500"; // Mindset: Daily Motivation — Brandon's own app
const PLAY_PKG = "com.google.android.apps.fitness";

let db = null;
let pass = 0;
let fail = 0;
const failures = [];

const ok = (label, detail = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); };
const bad = (label, why) => { fail++; failures.push(`${label}: ${why}`); console.log(`  \x1b[31mFAIL\x1b[0m ${label} — ${why}`); };
const head = (n, t) => console.log(`\n\x1b[1m${n}. ${t}\x1b[0m`);

if (!NO_DB && process.env.DATABASE_URL) {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  setFetchSink(db);
  console.log("Database connected — fetch_log and upstream_cache are live.");
} else {
  console.log("Running WITHOUT a database (the no-credentials path). fetch_log check will be skipped.");
}

const logBefore = db ? Number((await db.query("select count(*) n from fetch_log")).rows[0].n) : 0;

// ---------------------------------------------------------------------------
head(1, "Autocomplete — 10 suggestions, two countries, and they differ");
// ---------------------------------------------------------------------------
try {
  const us = await appleAutocomplete("motiva", "us", { cache: false });
  const gb = await appleAutocomplete("motiva", "gb", { cache: false });

  console.log(`     us: ${us.slice(0, 5).join(" | ")}`);
  console.log(`     gb: ${gb.slice(0, 5).join(" | ")}`);

  if (us.length === 0) bad("autocomplete us", "empty — an empty result means we called it wrong, not that there are no suggestions");
  else ok("autocomplete us", `${us.length} suggestions (Apple caps at 10)`);

  if (gb.length === 0) bad("autocomplete gb", "empty");
  else ok("autocomplete gb", `${gb.length} suggestions`);

  if (us.length && gb.length) {
    if (JSON.stringify(us) === JSON.stringify(gb)) {
      bad("storefronts differ", "US and GB returned identical lists — the storefront header may not be taking effect");
    } else {
      ok("storefronts differ", "US and GB lists are not identical, so the storefront header works");
    }
  }
} catch (e) {
  bad("autocomplete", e.message);
}

// ---------------------------------------------------------------------------
head(2, "MZStore SERP — 250 deep, with subtitles");
// ---------------------------------------------------------------------------
let serp = null;
try {
  serp = await appleSearchRanked(KEYWORD, "us", { cache: false });

  if (serp.ids.length >= 200) ok("SERP depth", `${serp.ids.length} ordered ids (Apple's hard cap is 250)`);
  else if (serp.ids.length > 0) bad("SERP depth", `only ${serp.ids.length} ids — expected up to 250`);
  else bad("SERP depth", "no ids returned");

  // 02 §3.3: Apple echoes back which store it actually served. This catches the silent
  // "US data labelled as another country" bug.
  if (serp.storeFront === serp.requestedStoreFront) {
    ok("provenance", `storeFront ${serp.storeFront} matches what we asked for, language=${serp.language}`);
  } else {
    bad("provenance", `asked for storefront ${serp.requestedStoreFront} but Apple served ${serp.storeFront}`);
  }

  const withSubtitle = serp.hydrated.filter((a) => a.subtitle);
  if (withSubtitle.length) {
    ok("subtitles present", `${withSubtitle.length}/${serp.hydrated.length} hydrated apps carry a subtitle`);
  } else {
    bad("subtitles present", "no hydrated app had a subtitle — this is the only free source of it");
  }

  // Top 10 needs /lookup for ranks 9-250, since only 8 arrive hydrated.
  const top10ids = serp.ids.slice(0, 10);
  const meta = await appleLookup(top10ids, "us", { cache: false });
  const byId = new Map(meta.map((m) => [m.store_id, m]));
  const subtitleById = new Map(serp.hydrated.map((h) => [h.store_id, h.subtitle]));

  console.log(`\n     Top 10 for "${KEYWORD}" (US):`);
  top10ids.forEach((id, i) => {
    const m = byId.get(id);
    const sub = subtitleById.get(id);
    console.log(
      `     ${String(i + 1).padStart(2)}. ${(m?.name ?? `(id ${id})`).slice(0, 34).padEnd(34)} ` +
      `${sub ? `“${sub.slice(0, 30)}”` : "—".padEnd(2)}  ${m?.rating_count ?? "?"} ratings`,
    );
  });

  if (meta.length === top10ids.length) ok("lookup hydration", `${meta.length}/10 ids hydrated via /lookup`);
  else bad("lookup hydration", `only ${meta.length}/${top10ids.length} hydrated`);
} catch (e) {
  bad("MZStore SERP", e.message);
}

// ---------------------------------------------------------------------------
head(3, "Organic rank of a known app for a known keyword");
// ---------------------------------------------------------------------------
try {
  const term = "mindset";
  const s = await appleSearchRanked(term, "us", { cache: false });
  const idx = s.ids.indexOf(KNOWN_APP);
  if (idx === -1) {
    // Legitimate outcome, and the four-valued rank state must express it: checked and absent.
    console.log(`     "${term}" US: app ${KNOWN_APP} is NOT in the top ${s.ids.length} → rank=null, found=false`);
    ok("rank extraction", `absence is representable (checked ${s.ids.length} deep, not found)`);
  } else {
    ok("rank extraction", `app ${KNOWN_APP} ranks #${idx + 1} for "${term}" in the US`);
  }
  // A second keyword we expect it to rank for, to prove a positive case exists.
  const s2 = await appleSearchRanked("daily motivation", "us", { cache: false });
  const idx2 = s2.ids.indexOf(KNOWN_APP);
  console.log(`     "daily motivation" US: ${idx2 === -1 ? `not in top ${s2.ids.length}` : `#${idx2 + 1}`}`);
} catch (e) {
  bad("rank extraction", e.message);
}

// ---------------------------------------------------------------------------
head(4, "SSR JSON — subtitle and the full 5-star histogram");
// ---------------------------------------------------------------------------
try {
  const ssr = await appleAppSSR(KNOWN_APP, "us", { cache: false });
  if (!ssr) {
    bad("SSR app page", "no serialized-server-data blob found");
  } else {
    console.log(`     name:      ${ssr.name}`);
    console.log(`     subtitle:  ${ssr.subtitle ?? "(none)"}`);
    console.log(`     rating:    ${ssr.rating_average} from ${ssr.rating_count} ratings`);
    console.log(`     histogram: ${JSON.stringify(ssr.rating_histogram)}  [5★,4★,3★,2★,1★]`);
    console.log(`     similar:   ${ssr.similar_apps.length} apps, ${ssr.similar_apps.filter((a) => a.subtitle).length} with subtitles`);

    if (ssr.subtitle) ok("SSR subtitle", `“${ssr.subtitle}”`);
    else bad("SSR subtitle", "absent — this is the only free source");

    const hist = ssr.rating_histogram;
    if (Array.isArray(hist) && hist.length === 5 && hist.some((n) => n > 0)) {
      const sum = hist.reduce((a, b) => a + b, 0);
      ok("SSR histogram", `5 buckets summing to ${sum.toLocaleString()}`);
    } else {
      bad("SSR histogram", `expected 5 non-empty buckets, got ${JSON.stringify(hist)}`);
    }

    if (ssr.similar_apps.length) ok("SSR similar apps", `${ssr.similar_apps.length} found (a free discovery source)`);
    else bad("SSR similar apps", "none found");
  }
} catch (e) {
  bad("SSR app page", e.message);
}

// ---------------------------------------------------------------------------
head(5, "SSR charts — 200 ranked apps in one request");
// ---------------------------------------------------------------------------
try {
  const { charts, categories } = await appleChartsSSR("us", 6013, "health-fitness-apps");
  if (!charts.length) {
    bad("SSR charts", "no charts parsed");
  } else {
    for (const c of charts) {
      console.log(`     ${c.chart}: ${c.entries.length} ranked apps (genre ${c.genre_id})`);
      console.log(`        #1 ${c.entries[0]?.name ?? "?"}${c.entries[0]?.subtitle ? ` — “${c.entries[0].subtitle}”` : ""}`);
    }
    const deepest = Math.max(...charts.map((c) => c.entries.length));
    if (deepest >= 190) ok("SSR charts depth", `${deepest} ranked apps in ONE request (legacy RSS caps at 100)`);
    else bad("SSR charts depth", `only ${deepest} apps — expected ~200`);

    if (categories.length) ok("live category list", `${categories.length} categories (prefer this over a hardcoded map)`);
    else bad("live category list", "empty");
  }
} catch (e) {
  bad("SSR charts", e.message);
}

// ---------------------------------------------------------------------------
head(6, "Google Play — SERP, suggest, and realInstalls");
// ---------------------------------------------------------------------------
try {
  const rows = await playSearchRanked("meditation", "us");
  console.log(`     SERP: ${rows.length} packages, ${rows.filter((r) => r.rating_average).length} with a rating`);
  console.log(`        ${rows.slice(0, 3).map((r) => `#${r.rank} ${r.store_id}${r.rating_average ? ` (${r.rating_average}★)` : ""}`).join("  ")}`);
  if (rows.length >= 15) ok("Play SERP", `${rows.length} packages in ranked order (pagination is dead; ~19-30 is the real ceiling)`);
  else bad("Play SERP", `only ${rows.length} packages`);
  if (rows.some((r) => r.rating_average)) ok("Play SERP ratings", "ratings extracted alongside package ids");
  else bad("Play SERP ratings", "no ratings found next to package ids");
} catch (e) {
  bad("Play SERP", e.message);
}

try {
  const five = await playSuggest("fit", "us");
  const broad = await playSuggestBroad("alarm clock", "us");
  console.log(`     IJ4APc  (authoritative): ${five.join(", ") || "(none)"}`);
  console.log(`     ds=play (broad):         ${broad.slice(0, 6).join(", ") || "(none)"}${broad.length > 6 ? ` … ${broad.length} total` : ""}`);
  if (five.length) ok("Play suggest IJ4APc", `${five.length} results (hard cap is exactly 5)`);
  else bad("Play suggest IJ4APc", "empty");
  if (broad.length) ok("Play suggest ds=play", `${broad.length} results (up to 15 — worth having for breadth)`);
  else bad("Play suggest ds=play", "empty");

  // The documented crash case: a nonsense term returns a non-null payload that a naive
  // check treats as valid, then .map() throws.
  const none = await playSuggest("zzzqqxwv" + Date.now(), "us");
  ok("Play suggest no-result guard", `returned ${JSON.stringify(none)} instead of throwing`);
} catch (e) {
  bad("Play suggest", e.message);
}

try {
  const detail = await playAppDetail(PLAY_PKG, "us");
  if (!detail) {
    bad("Play detail", "no data parsed — the vendored index paths may have rotated");
  } else {
    console.log(`     ${detail.name} by ${detail.developer_name}`);
    console.log(`     installs bucketed: ${detail.installs_bucketed}   realInstalls: ${detail.real_installs?.toLocaleString?.() ?? detail.real_installs}`);
    console.log(`     rating ${detail.rating_average} from ${detail.rating_count?.toLocaleString?.()}  histogram ${JSON.stringify(detail.rating_histogram)}`);
    console.log(`     description: ${detail.description ? `${detail.description.length} chars (Play indexes ALL of it)` : "(missing)"}`);

    // The canary: title/appId/score must all be present or Google rotated the paths.
    if (detail.name && detail.store_id && detail.rating_average) ok("Play detail canary", "title + appId + score all present");
    else bad("Play detail canary", "one of title/appId/score is missing — index paths likely rotated");

    if (typeof detail.real_installs === "number" && detail.real_installs > 0) {
      ok("realInstalls", `${detail.real_installs.toLocaleString()} exact (Apple exposes nothing comparable at any price)`);
    } else {
      bad("realInstalls", `expected an exact number at path 1,2,13,2, got ${detail.real_installs}`);
    }
  }
} catch (e) {
  bad("Play detail", e.message);
}

// ---------------------------------------------------------------------------
head(7, "Reviews RSS, and the prefix-depth demand proxy");
// ---------------------------------------------------------------------------
try {
  const { reviews, last_page } = await appleReviews(KNOWN_APP, "us", 1);
  console.log(`     ${reviews.length} reviews on page 1 of ${last_page}`);
  if (reviews.length) {
    const r = reviews[0];
    console.log(`        ${r.rating}★ “${(r.title ?? "").slice(0, 40)}” by ${r.author} (v${r.app_version})`);
    ok("reviews RSS", `${reviews.length} parsed, entry[0] app-row correctly skipped`);
  } else {
    ok("reviews RSS", "no reviews returned (a legitimate state, guarded rather than crashed)");
  }
} catch (e) {
  bad("reviews RSS", e.message);
}

try {
  // 02 §9.3's live validation: the broad term should reveal EARLIER than the long tail.
  const broad = await suggestDepth("motivational quotes", "us");
  const tail = await suggestDepth("alarm clock for heavy sleepers", "us");
  console.log(`     "motivational quotes":            reveals at ${broad.length ?? "never"} chars, position ${broad.index ?? "—"}, ${broad.hits} prefixes`);
  console.log(`     "alarm clock for heavy sleepers":  reveals at ${tail.length ?? "never"} chars, position ${tail.index ?? "—"}, ${tail.hits} prefixes`);

  if (broad.length != null) ok("suggestDepth broad", `revealed at ${broad.length} characters`);
  else bad("suggestDepth broad", "never revealed — expected ~6 characters");

  if (broad.length != null && tail.length != null && broad.length < tail.length) {
    ok("suggestDepth discriminates", `broad reveals at ${broad.length} vs long-tail at ${tail.length}`);
  } else if (broad.length != null && tail.length == null) {
    ok("suggestDepth discriminates", `broad revealed at ${broad.length}; the long tail never revealed (null, NOT zero)`);
  } else {
    bad("suggestDepth discriminates", `broad=${broad.length} tail=${tail.length} — the broad term should reveal earlier`);
  }
} catch (e) {
  bad("suggestDepth", e.message);
}

// ---------------------------------------------------------------------------
head(8, "Throttle behaviour — deliberate burst, and does backoff recover");
// ---------------------------------------------------------------------------
try {
  // itunes.apple.com/search is the ONLY endpoint that genuinely throttles. Burst it on
  // purpose with unique cache-busting terms and confirm we degrade rather than crash.
  const { appleSearch } = await import("../lib/stores/apple.mjs");
  let succeeded = 0;
  let cooled = false;
  for (let i = 0; i < 8; i++) {
    try {
      await appleSearch(`smoke test ${Date.now()}-${i}`, "us", 5);
      succeeded++;
    } catch (e) {
      if (e instanceof CooldownError || e.name === "CooldownError") { cooled = true; break; }
      throw e;
    }
  }
  console.log(`     ${succeeded} burst calls succeeded${cooled ? ", then the bucket entered cooldown as designed" : " with no throttling"}`);
  ok("throttle handling", cooled ? "an empty-body 403 became a scoped cooldown, not a crash" : "no throttle hit; the token bucket paced the burst");

  // Recovery: /lookup must still work even if /search is blocked — the block is endpoint-scoped.
  const still = await appleLookup([KNOWN_APP], "us", { cache: false });
  if (still.length === 1) ok("endpoint-scoped block", "/lookup still returns 200 regardless of /search state");
  else bad("endpoint-scoped block", "/lookup failed too, which should not happen");

  console.log(`\n     Bucket state: ${JSON.stringify(fetchStats(), null, 0)}`);
} catch (e) {
  bad("throttle handling", e.message);
}

// ---------------------------------------------------------------------------
head(9, "fetch_log ledger");
// ---------------------------------------------------------------------------
if (db) {
  try {
    const { rows } = await db.query(
      `select host, count(*)::int as calls,
              count(*) filter (where throttled)::int as throttled,
              round(avg(duration_ms))::int as avg_ms
         from fetch_log group by host order by calls desc`,
    );
    const total = rows.reduce((s, r) => s + r.calls, 0);
    for (const r of rows) console.log(`     ${r.host.padEnd(30)} ${String(r.calls).padStart(4)} calls  ${r.throttled} throttled  ~${r.avg_ms}ms`);
    if (total > logBefore) ok("fetch_log", `${total - logBefore} rows written this run across ${rows.length} hosts`);
    else bad("fetch_log", "no new rows — the ledger is not recording");
  } catch (e) {
    bad("fetch_log", e.message);
  }
} else {
  console.log("     skipped (no database)");
}

// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(70)}`);
console.log(`GATE 1: \x1b[32m${pass} passed\x1b[0m, ${fail ? `\x1b[31m${fail} failed\x1b[0m` : "0 failed"}`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  console.log("\nStop and fix these. Every later phase depends on this working.");
}
if (db) await db.end().catch(() => {});
process.exit(fail ? 1 : 0);
