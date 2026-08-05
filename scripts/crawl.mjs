/**
 * The nightly crawler — 07-CRAWLER-AND-JOBS.md.
 *
 * Standalone by design: node:fs + fetch + pg only, runnable as `node scripts/crawl.mjs` from
 * Brandon's laptop with no build step. That is not a stylistic choice — a single GitHub
 * Actions runner is one IP, and if Apple ever blocks it the fix is to run this same file
 * locally, unchanged.
 *
 * NEVER THROWS ON A MISSING CREDENTIAL. Every optional integration degrades to a warning and
 * the run continues. A missing App Store Connect key must empty out /performance, not kill
 * the night's rank tracking.
 *
 * Usage:
 *   node scripts/crawl.mjs --all                  every job, every active app
 *   node scripts/crawl.mjs --jobs rank_check,rollup
 *   node scripts/crawl.mjs --date 2026-08-01      pretend it is another day (Gate 3)
 *   node scripts/crawl.mjs --limit 20             cap keywords, for a quick pass
 *   node scripts/crawl.mjs --dry                  fetch nothing, just report the plan
 */
import { connect, q, q1, upsertApp, upsertKeyword } from "../lib/db.mjs";
import { setFetchSink, fetchStats, pruneCache, CooldownError } from "../lib/stores/http.mjs";
import {
  appleLookup,
  appleAppSSR,
  appleReviews,
  appleAutocomplete,
  suggestDepth,
  appleInAppPurchases,
  appleChartsSSR,
  appleChartsRSS,
} from "../lib/stores/apple.mjs";
import { playAppDetail, playSuggest, playSuggestBroad, extractListingKeywords, playCategoryRanking, playReviews } from "../lib/stores/play.mjs";
import { fetchIosSerp, fetchAndroidSerp, persistSerp, updateKeywordSerpMetrics } from "../lib/serp.mjs";
import { scanCompetitor, bigrams, isJunkTerm } from "../lib/competitor-scan.mjs";
import { aiEnabled, scoreRelevance, generateKeywordCandidates, verifyCandidate } from "../lib/ai.mjs";
import {
  popularityProxy,
  popularityProxyAndroid,
  fitProxyCalibration,
  applyProxyCalibration,
  popularityEffective,
  opportunity,
  visibilityAndShareOfVoice,
  bracketCounts,
  competitiveBucket,
  delta,
  average,
  estDownloadsAtRank1,
  evaluateAlerts,
  meanStdDev,
  isBranded,
  revenueEstimate,
} from "../lib/scoring/scores.mjs";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (flag) => argv.includes(flag);

/**
 * Watched fields whose change becomes an activity_events row.
 *
 * Declared UP HERE, above the job blocks, not next to persistSnapshot() where it reads more
 * naturally. The job blocks execute at module scope top-to-bottom, so any `const` they reach
 * indirectly must already be initialised. This one is only touched when a PREVIOUS snapshot
 * exists, so declaring it lower passed cleanly on day 1 and threw on day 2 — the worst kind
 * of bug to leave in a nightly job.
 */
const WATCHED = [
  ["version", "release"],
  ["name", "metadata"],
  ["subtitle", "metadata"],
  ["description", "metadata"],
  ["release_notes", "metadata"],
  ["price_cents", "price"],
  ["primary_genre", "category"],
  ["icon_url", "icon"],
];

const ALL_JOBS = ["app_snapshot", "charts", "revenue", "asc_sync", "play_sync", "rank_check", "autocomplete", "metrics", "discovery", "reviews", "rollup", "alerts"];
const JOBS = has("--all") || !arg("--jobs") ? ALL_JOBS : arg("--jobs").split(",").map((s) => s.trim()).filter(Boolean);
const RUN_DATE = arg("--date") ?? new Date().toISOString().slice(0, 10);
const LIMIT = Number(arg("--limit", "0")) || 0;
const DRY = has("--dry");

/**
 * A HARD wall-clock budget, in minutes. This is the thing that stops GitHub Actions minutes
 * from ever becoming a surprise bill.
 *
 * Measured cost is ~11s per keyword, ~85% of which is the politeness limiter sleeping rather
 * than network time. So the nightly run grows linearly with the tracked keyword set, and
 * without a ceiling a growing keyword list silently walks past the free tier.
 *
 * When the budget runs out the crawl STOPS CLEANLY: work already persisted is kept (we save
 * after every keyword), the job is marked `partial`, and a warning records exactly how much
 * was left. Tomorrow's run picks up where this one stopped, because the rank_check queue
 * already skips keywords that have a row for today and orders by staleness.
 */
const MAX_MINUTES = Number(arg("--max-minutes", "0")) || 0;
const deadline = MAX_MINUTES ? Date.now() + MAX_MINUTES * 60_000 : Infinity;
const outOfTime = () => Date.now() > deadline;
const minutesLeft = () => (deadline === Infinity ? Infinity : Math.max(0, (deadline - Date.now()) / 60_000));

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.log(`  ⚠ ${msg}`);
};

const log = (msg) => console.log(msg);
const started = Date.now();

// ---------------------------------------------------------------------------
const db = await connect();
setFetchSink(db);
// Adapter for lib/serp.mjs, whose functions take a plain `query(sql, params) => rows[]`.
const dbq = (sql, params) => q(db, sql, params);

// Apple's decade-stable genre ids (apps only — Games charts use a different URL shape).
// Used by the charts snapshot job and discovery Source E.
const APPLE_GENRE_IDS = {
  "books": 6018, "business": 6000, "developer tools": 6026, "education": 6017,
  "entertainment": 6016, "finance": 6015, "food & drink": 6023, "graphics & design": 6027,
  "health & fitness": 6013, "lifestyle": 6012, "magazines & newspapers": 6021,
  "medical": 6020, "music": 6011, "navigation": 6010, "news": 6009,
  "photo & video": 6008, "productivity": 6007, "reference": 6006, "shopping": 6024,
  "social networking": 6005, "sports": 6004, "travel": 6003, "utilities": 6002, "weather": 6001,
};

log(`\ntrysearch crawl — ${RUN_DATE}`);
log(`jobs: ${JOBS.join(", ")}${DRY ? "  (DRY RUN — no upstream fetches)" : ""}${MAX_MINUTES ? `  ·  budget ${MAX_MINUTES} min` : ""}\n`);

// Optional credentials: detected, never printed, never fatal.
for (const [name, feature] of [
  ["ASC_PRIVATE_KEY_FILE", "App Store Connect analytics (/performance, /engagement)"],
  ["PLAY_SERVICE_ACCOUNT_FILE", "Play Console real search terms"],
  ["RESEND_API_KEY", "alert digest emails"],
  ["ANTHROPIC_API_KEY", "the 4 optional AI features"],
]) {
  if (!process.env[name]) warn(`${name} is not set — ${feature} is skipped.`);
}

/** Opens a crawl_jobs row so the crawler's behaviour is queryable rather than guessed at. */
async function startJob(kind, scope = {}, itemsTotal = null) {
  const row = await q1(
    db,
    `insert into crawl_jobs (kind, status, scope, items_total, items_done, attempts, started_at)
     values ($1, 'running', $2::jsonb, $3, 0, 1, now()) returning id`,
    [kind, JSON.stringify(scope), itemsTotal],
  );
  return row.id;
}

async function bumpJob(id, done) {
  await db.query(`update crawl_jobs set items_done = $2 where id = $1`, [id, done]);
}

async function finishJob(id, status, jobWarnings = [], error = null) {
  await db.query(
    `update crawl_jobs set status = $2, warnings = $3::jsonb, error = $4, finished_at = now() where id = $1`,
    [id, status, JSON.stringify(jobWarnings), error],
  );
}

// ===========================================================================
// Load the tracked universe
// ===========================================================================
const trackedApps = await q(
  db,
  `select ta.id as tracked_app_id, ta.workspace_id, ta.role, ta.competitor_of, ta.device,
          ta.auto_track_ranked,
          a.id as app_id, a.platform, a.store_id, a.name, a.primary_genre
     from tracked_apps ta
     join apps a on a.id = ta.app_id
    where ta.is_active
    order by ta.role desc, a.name`,
);

if (!trackedApps.length) {
  log("No active tracked apps. Add one in the UI (or with scripts/seed-app.mjs) and re-run.");
  await finalReport();
  process.exit(0);
}

log(`${trackedApps.length} tracked app(s): ${trackedApps.filter((a) => a.role === "own").length} own, ${trackedApps.filter((a) => a.role === "competitor").length} competitor\n`);

// ===========================================================================
// JOB 1 — app_snapshot: metadata + diff → activity_events + auto annotations
// ===========================================================================
if (JOBS.includes("app_snapshot")) {
  const jobId = await startJob("app_snapshot", { date: RUN_DATE }, trackedApps.length);
  const jobWarnings = [];
  let done = 0;

  log("1. app_snapshot");
  for (const app of trackedApps) {
    const countries = await countriesFor(app);
    for (const country of countries) {
      try {
        const snap = DRY ? null : await snapshotApp(app, country);
        if (!snap) continue;
        await persistSnapshot(app, country, snap, jobWarnings);
      } catch (err) {
        if (err instanceof CooldownError) jobWarnings.push(`app_snapshot ${app.name} ${country}: ${err.message}`);
        else jobWarnings.push(`app_snapshot ${app.name} ${country}: ${err.message}`);
      }
    }
    await bumpJob(jobId, ++done);
  }
  log(`   ${done} app(s) snapshotted${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

async function snapshotApp(app, country) {
  if (app.platform === "ios") {
    const [meta] = await appleLookup([app.store_id], country);
    // The SSR page is the ONLY free source of the subtitle and the rating histogram.
    const ssr = await appleAppSSR(app.store_id, country).catch(() => null);
    if (!meta && !ssr) return null;
    return {
      name: ssr?.name ?? meta?.name ?? null,
      subtitle: ssr?.subtitle ?? null,
      description: ssr?.description ?? meta?.description ?? null,
      release_notes: ssr?.release_notes ?? meta?.release_notes ?? null,
      version: meta?.version ?? null,
      price_cents: meta?.price_cents ?? null,
      currency: meta?.currency ?? null,
      primary_genre: meta?.primary_genre ?? null,
      icon_url: meta?.icon_url ?? null,
      screenshot_urls: meta?.screenshot_urls ?? [],
      // /lookup is PRECISE (4.7); the SSR page is FRESHER. Prefer lookup for the average and
      // the SSR page for the count, which is the combination that is both.
      rating_average: meta?.rating_average ?? ssr?.rating_average ?? null,
      rating_count: ssr?.rating_count ?? meta?.rating_count ?? null,
      install_count: null, // Apple exposes nothing comparable at any price
      raw: { meta, ssr },
      apps_row: meta ?? null,
    };
  }

  const d = await playAppDetail(app.store_id, country);
  if (!d) return null;
  return {
    name: d.name,
    subtitle: d.summary, // Play's 80-char short description is the closest analogue, and IS indexed
    description: d.description,
    release_notes: null,
    version: null,
    price_cents: d.price_cents,
    currency: d.currency,
    primary_genre: d.primary_genre,
    icon_url: d.icon_url,
    screenshot_urls: d.screenshot_urls ?? [],
    rating_average: d.rating_average,
    rating_count: d.rating_count,
    install_count: d.real_installs, // the exact number Play publishes
    raw: d,
    apps_row: d,
  };
}

async function persistSnapshot(app, country, snap, jobWarnings) {
  const prev = await q1(
    db,
    `select * from app_snapshots where app_id = $1 and country = $2 and captured_on < $3
     order by captured_on desc limit 1`,
    [app.app_id, country, RUN_DATE],
  );

  await db.query(
    `insert into app_snapshots (app_id, country, captured_on, name, subtitle, description,
        release_notes, version, price_cents, currency, primary_genre, icon_url, screenshot_urls,
        rating_average, rating_count, install_count, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
     on conflict (app_id, country, captured_on) do update set
       name = excluded.name, subtitle = excluded.subtitle, description = excluded.description,
       release_notes = excluded.release_notes, version = excluded.version,
       price_cents = excluded.price_cents, currency = excluded.currency,
       primary_genre = excluded.primary_genre, icon_url = excluded.icon_url,
       screenshot_urls = excluded.screenshot_urls, rating_average = excluded.rating_average,
       rating_count = excluded.rating_count, install_count = excluded.install_count,
       raw = excluded.raw`,
    [
      app.app_id, country, RUN_DATE, snap.name, snap.subtitle, snap.description,
      snap.release_notes, snap.version, snap.price_cents, snap.currency, snap.primary_genre,
      snap.icon_url, snap.screenshot_urls, snap.rating_average, snap.rating_count,
      snap.install_count, JSON.stringify(snap.raw ?? {}),
    ],
  );

  if (snap.apps_row) await upsertApp(db, { ...snap.apps_row, platform: app.platform, store_id: app.store_id });

  // Screenshot changes are compared as a set, not field-wise.
  if (prev) {
    const before = (prev.screenshot_urls ?? []).join("|");
    const after = (snap.screenshot_urls ?? []).join("|");
    if (before !== after && (before || after)) {
      await insertEvent(app, country, "screenshots", "screenshot_urls", `${(prev.screenshot_urls ?? []).length} images`, `${snap.screenshot_urls.length} images`, null);
    }

    for (const [field, kind] of WATCHED) {
      const oldV = prev[field] == null ? null : String(prev[field]);
      const newV = snap[field] == null ? null : String(snap[field]);
      if (oldV === newV) continue;
      // A field going from absent to present on the FIRST comparison is usually us gaining a
      // data source, not the developer changing anything. Only report real transitions.
      if (oldV == null && newV != null && field !== "version") continue;

      await insertEvent(app, country, kind, field, truncate(oldV), truncate(newV), field === "version" ? snap.release_notes : null);

      // A version change auto-creates a chart annotation (07 §4).
      if (field === "version" && newV) {
        await db.query(
          `insert into annotations (tracked_app_id, occurred_on, label, auto)
           select $1, $2, $3, true
           where not exists (select 1 from annotations where tracked_app_id = $1 and occurred_on = $2 and label = $3)`,
          [app.tracked_app_id, RUN_DATE, `Shipped ${newV}`],
        );
      }
    }
  }
}

async function insertEvent(app, country, kind, field, oldValue, newValue, releaseNotes) {
  await db.query(
    `insert into activity_events (app_id, country, kind, field, old_value, new_value, release_notes, occurred_on)
     select $1,$2,$3,$4,$5,$6,$7,$8
     where not exists (
       select 1 from activity_events
        where app_id = $1 and coalesce(country,'') = coalesce($2,'') and kind = $3
          and coalesce(field,'') = coalesce($4,'') and occurred_on = $8
          and coalesce(new_value,'') = coalesce($6,''))`,
    [app.app_id, country, kind, field, oldValue, newValue, releaseNotes, RUN_DATE],
  );
}

// A `function`, not a const arrow — see the note on minOrNull. persistSnapshot() calls this
// during job 1, which runs before this line is reached, and only when a PREVIOUS snapshot
// exists. As a const it would have thrown on day 2 while passing cleanly on day 1.
function truncate(s) {
  return s == null ? null : s.length > 500 ? `${s.slice(0, 497)}…` : s;
}

// ===========================================================================
// JOB 1a½ — charts: daily top-chart snapshots → chart_entries (Workstream H)
// The /top-charts page needs STORED history for day-over-day movement; the live
// charts op has no memory. Cheap: RSS/HTML fetches, all cached by the fetch layer.
// ===========================================================================
if (JOBS.includes("charts")) {
  const own = trackedApps.filter((a) => a.role === "own");

  // One snapshot per (platform, country, category, chart) the team's apps live in:
  // the overall chart plus each app's primary genre.
  const combos = new Map();
  for (const app of own) {
    for (const country of await countriesFor(app)) {
      if (app.platform === "ios") {
        const genreId = app.primary_genre ? APPLE_GENRE_IDS[app.primary_genre.toLowerCase()] : null;
        for (const chart of ["topfreeapplications", "topgrossingapplications", "toppaidapplications"]) {
          combos.set(`ios|${country}|all|${chart}`, { platform: "ios", country, category: "all", chart, genreId: null });
          if (genreId) combos.set(`ios|${country}|${genreId}|${chart}`, { platform: "ios", country, category: String(genreId), chart, genreId });
        }
      } else {
        // Play's category id convention IS the uppercased genre name.
        const catId = app.primary_genre ? app.primary_genre.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : null;
        combos.set(`android|${country}|APPLICATION|default`, { platform: "android", country, category: "APPLICATION", chart: "default" });
        if (catId) combos.set(`android|${country}|${catId}|default`, { platform: "android", country, category: catId, chart: "default" });
      }
    }
  }

  const jobId = await startJob("charts", { date: RUN_DATE }, combos.size);
  const jobWarnings = [];
  let done = 0;
  let rowsWritten = 0;

  log(`1½. charts — ${combos.size} (store, country, category, chart) snapshot(s)`);

  for (const combo of combos.values()) {
    if (outOfTime()) { jobWarnings.push(`charts stopped at ${done}/${combos.size} — budget exhausted.`); break; }
    try {
      if (DRY) { done++; continue; }

      const entries = combo.platform === "ios"
        ? await appleChartsRSS(combo.country, combo.genreId, combo.chart, 100)
        : await playCategoryRanking(combo.category, combo.country);
      if (!entries.length) { jobWarnings.push(`charts ${combo.platform}/${combo.country}/${combo.category}/${combo.chart}: empty`); await bumpJob(jobId, ++done); continue; }

      // Thin app upsert + entries, both batched (same round-trip rule as persistSerp).
      const appValues = [];
      const appParams = [];
      entries.forEach((e, i) => {
        const base = i * 4;
        appValues.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
        appParams.push(combo.platform, String(e.store_id), e.name ?? `(app ${e.store_id})`, e.developer_name ?? null);
      });
      const appRows = await q(
        db,
        `insert into apps (platform, store_id, name, developer_name)
         values ${appValues.join(",")}
         on conflict (platform, store_id) do update set
           name = coalesce(excluded.name, apps.name),
           developer_name = coalesce(excluded.developer_name, apps.developer_name),
           updated_at = now()
         returning id, store_id`,
        appParams,
      );
      const idByStoreId = new Map(appRows.map((r) => [String(r.store_id), r.id]));

      const values = [];
      const params = [];
      let n = 0;
      for (const e of entries) {
        const appId = idByStoreId.get(String(e.store_id));
        if (!appId) continue;
        const base = n * 7;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
        params.push(combo.platform, combo.country, combo.category, combo.chart, RUN_DATE, e.rank, appId);
        n++;
      }
      if (n) {
        await db.query(
          `insert into chart_entries (platform, country, category, chart, captured_on, rank, app_id)
           values ${values.join(",")}
           on conflict (platform, country, category, chart, captured_on, rank) do update set app_id = excluded.app_id`,
          params,
        );
        rowsWritten += n;
      }
    } catch (err) {
      jobWarnings.push(`charts ${combo.platform}/${combo.country}/${combo.category}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  log(`   ${rowsWritten} chart row(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

// ===========================================================================
// JOB 1b — revenue: real scraped IAP prices → app_iaps + revenue_estimates
// ===========================================================================
/**
 * Runs immediately after app_snapshot ON PURPOSE, and that placement is the whole reason this
 * job is affordable. `appleInAppPurchases` reads the same store page as `appleAppSSR` and uses
 * the SAME cache key (`ssr:app:{country}:{id}`), and `playAppDetail` likewise — so by the time
 * this job runs, both fetches are already in upstream_cache from job 1. The marginal network
 * cost of estimating revenue is therefore ~zero, not "one store-page fetch per app per day".
 *
 * The scoring is entirely in lib/scoring/scores.mjs (pure, unit-tested). This job only feeds it
 * real inputs and records what it was told, including the factors, so /revenue can show its work.
 */
if (JOBS.includes("revenue")) {
  const jobId = await startJob("revenue", { date: RUN_DATE }, trackedApps.length);
  const jobWarnings = [];
  let done = 0;
  let estimated = 0;
  let iapRows = 0;

  log(`1b. revenue — ${trackedApps.length} app(s), scoring from real scraped prices`);

  // ONE calibration anchor per run, shared by every app on the chart: a measured app whose
  // grossing rank we also know. Without it the grossing-rank model reports rank and no dollars.
  // REVENUE_ANCHOR_USD_MONTH lets you supply the monthly figure by hand (from RevenueCat, say)
  // when App Store Connect proceeds are not wired up.
  const revenueAnchor = await (async () => {
    const manual = Number(process.env.REVENUE_ANCHOR_USD_MONTH ?? 0);
    for (const own of trackedApps.filter((a) => a.role === "own")) {
      const rankRow = await q1(
        db,
        `select rank, category from chart_entries
          where app_id = $1 and chart like '%grossing%' and country = 'us'
          order by captured_on desc, (category = 'all') asc limit 1`,
        [own.app_id],
      );
      if (!rankRow?.rank) continue;
      const proceeds = await q1(
        db,
        `select sum(proceeds_usd)::float as usd from asc_daily_metrics
          where app_id = $1 and country = 'ALL' and metric_on > current_date - 31`,
        [own.app_id],
      );
      const monthlyUsd = Number(proceeds?.usd) || manual;
      if (monthlyUsd > 0) return { rank: rankRow.rank, monthlyUsd, label: own.name };
    }
    return null;
  })();
  if (!revenueAnchor) jobWarnings.push("revenue: no calibration anchor (no measured proceeds for an own app on a grossing chart, and REVENUE_ANCHOR_USD_MONTH unset) — grossing ranks will be reported without dollar figures.");

  for (const app of trackedApps) {
    try {
      if (DRY) { await bumpJob(jobId, ++done); continue; }
      // ALWAYS the US storefront, never countriesFor(app). revenue_estimates is denominated in
      // USD (monthly_usd_low/high, "$271K/mo"), so the prices feeding it have to be USD — and
      // countriesFor returns whatever storefront the app happens to track first, which for
      // Mindset was 'gb'. That silently produced GBP prices, which the estimator then read as
      // "no in-app purchases", classifying a subscription app as ad-supported at <$5K/mo.
      const country = "us";

      // Latest snapshot carries the rating count (iOS) and the exact install count (Android).
      const snap = await q1(
        db,
        `select rating_count, install_count from app_snapshots
          where app_id = $1 order by captured_on desc limit 1`,
        [app.app_id],
      );
      const meta = await q1(db, `select price_cents, released_at, primary_genre from apps where id = $1`, [app.app_id]);

      // Months on sale — the divisor that turns a lifetime total into a monthly rate. A wrong
      // default here silently scales the whole estimate, so it comes from the real release date.
      const lifetimeMonths = meta?.released_at
        ? Math.max(1, Math.round((Date.now() - new Date(meta.released_at).getTime()) / (30 * 24 * 3600 * 1000)))
        : null;

      let iaps = [];
      let priceCents = meta?.price_cents ?? 0;
      let realInstalls = null;

      if (app.platform === "ios") {
        iaps = await appleInAppPurchases(app.store_id, country);
      } else {
        const detail = await playAppDetail(app.store_id, country);
        priceCents = detail?.price_cents ?? priceCents;
        realInstalls = detail?.real_installs ?? snap?.install_count ?? null;
        // Play's page does not itemise IAP prices the way Apple's does; the flag is all we get.
        if (detail?.has_iap) iaps = [];
      }

      for (const iap of iaps) {
        const res = await db.query(
          `insert into app_iaps (app_id, name, price_cents, currency, is_subscription, period, annualised_cents, captured_on)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (app_id, name, captured_on) do update set
             price_cents = excluded.price_cents, annualised_cents = excluded.annualised_cents
           returning (xmax = 0) as is_new`,
          [app.app_id, iap.name, iap.price_cents, iap.currency, iap.is_subscription, iap.period, iap.annualised_cents, RUN_DATE],
        );
        if (res.rows[0]?.is_new) iapRows++;
      }

      // Signal 1 — measured proceeds (own apps with App Store Connect). Last full 30 days.
      const measured = await q1(
        db,
        `select sum(proceeds_usd)::float as usd from asc_daily_metrics
          where app_id = $1 and country = 'ALL' and metric_on > current_date - 31`,
        [app.app_id],
      );

      // Signal 2 — today's top-grossing rank. Category chart first (a category rank is a much
      // tighter revenue bracket than the all-apps chart), US storefront to match USD prices.
      const grossing = await q1(
        db,
        `select rank, category, country from chart_entries
          where app_id = $1 and chart like '%grossing%' and country = 'us'
          order by captured_on desc, (category = 'all') asc
          limit 1`,
        [app.app_id],
      );

      // Rating velocity from our own snapshot history: one storefront only (ratings are
      // per-storefront, so mixing them measures nothing), widest window up to 90 days.
      const velocity = await q1(
        db,
        `with series as (
           select captured_on, rating_count from app_snapshots
            where app_id = $1 and country = $2 and rating_count is not null
              and captured_on > current_date - 90
         )
         select (max(captured_on) - min(captured_on)) as days,
                (select rating_count from series order by captured_on desc limit 1)
              - (select rating_count from series order by captured_on asc limit 1) as delta
           from series`,
        [app.app_id, country],
      );
      const monthlyRatings =
        // Five days is the shortest window whose slope is not mostly noise.
        velocity?.days >= 5 && Number(velocity.delta) > 0 ? (Number(velocity.delta) * 30) / Number(velocity.days) : null;

      const est = revenueEstimate({
        platform: app.platform,
        // REVENUE_ANCHOR_USD_MONTH is the truth for our OWN app when App Store Connect proceeds
        // are not wired up: a real figure Brandon reads off RevenueCat beats any model of it.
        measuredMonthlyUsd:
          Number(measured?.usd) ||
          (app.role === "own" ? Number(process.env.REVENUE_ANCHOR_USD_MONTH ?? 0) || null : null),
        grossingRank: grossing?.rank ?? null,
        grossingChartLabel: grossing
          ? `the US top-grossing chart${grossing.category === "all" ? "" : ` for category ${grossing.category}`}`
          : null,
        anchor: revenueAnchor,
        realInstalls: realInstalls == null ? null : Number(realInstalls),
        ratingCount: snap?.rating_count == null ? null : Number(snap.rating_count),
        monthlyRatings,
        category: meta?.primary_genre ?? null,
        priceCents,
        iaps,
        lifetimeMonths,
      });

      await db.query(
        `insert into revenue_estimates (app_id, estimated_on, model, confidence, monthly_usd_low, monthly_usd_high, display, factors, method, grossing_rank)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (app_id, estimated_on) do update set
           model = excluded.model, confidence = excluded.confidence,
           monthly_usd_low = excluded.monthly_usd_low, monthly_usd_high = excluded.monthly_usd_high,
           display = excluded.display, factors = excluded.factors,
           method = excluded.method, grossing_rank = excluded.grossing_rank, computed_at = now()`,
        [app.app_id, RUN_DATE, est.model, est.confidence, est.monthly_usd_low, est.monthly_usd_high, est.display, JSON.stringify(est.factors), est.method, est.grossing_rank],
      );
      estimated++;
    } catch (err) {
      jobWarnings.push(`revenue ${app.name}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  log(`   ${estimated} estimate(s), ${iapRows} new in-app price(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

// ===========================================================================
// JOB 1c — asc_sync: App Store Connect first-party downloads + engagement
// ===========================================================================
/**
 * Only runs for OWN iOS apps — Apple's Analytics/Sales APIs answer for apps this key has
 * Admin/Sales-and-Reports/Finance access to, which is never a competitor's. Degrades to a
 * warning (not a throw) when ASC_ISSUER_ID/ASC_KEY_ID/the private key are absent, same rule
 * every other credentialed job follows.
 */
if (JOBS.includes("asc_sync")) {
  const { ascConfigured, ascVendorConfigured, fetchEngagementRows, aggregateEngagement, fetchSalesReportTsv, parseSalesReport, fetchListingLocalizations } =
    await import("../lib/stores/asc.mjs");

  if (!ascConfigured()) {
    warnings.push("ASC_ISSUER_ID / ASC_KEY_ID / ASC private key not set — App Store Connect sync is skipped.");
  } else {
    const ownIos = trackedApps.filter((a) => a.role === "own" && a.platform === "ios");
    const jobId = await startJob("asc_sync", { date: RUN_DATE }, ownIos.length);
    const jobWarnings = [];
    let done = 0;
    let rowsWritten = 0;

    log(`1c. asc_sync — ${ownIos.length} own iOS app(s)`);
    if (!ascVendorConfigured()) jobWarnings.push("ASC_VENDOR_NUMBER not set — downloads/proceeds (Sales Reports) skipped; engagement still runs.");

    for (const app of ownIos) {
      try {
        // Engagement funnel — impressions, page views, source breakdown.
        const { rows, note } = await fetchEngagementRows(app.store_id);
        if (note) jobWarnings.push(`asc engagement ${app.name}: ${note}`);
        const perCountry = aggregateEngagement(rows, app.store_id);

        // /performance and /engagement both read country = 'ALL' for the KPI strip and the
        // daily chart, and per-country rows only for the "top countries" breakdown — so the
        // worldwide total needs its own row per day, summed across every territory.
        const allByDate = new Map();
        for (const day of perCountry) {
          if (!allByDate.has(day.date)) {
            allByDate.set(day.date, { date: day.date, country: "ALL", impressions: 0, product_page_views: 0, impressions_search: 0, impressions_browse: 0, impressions_app_referrer: 0, impressions_web_referrer: 0 });
          }
          const t = allByDate.get(day.date);
          t.impressions += day.impressions;
          t.product_page_views += day.product_page_views;
          t.impressions_search += day.impressions_search;
          t.impressions_browse += day.impressions_browse;
          t.impressions_app_referrer += day.impressions_app_referrer;
          t.impressions_web_referrer += day.impressions_web_referrer;
        }

        for (const day of [...perCountry, ...allByDate.values()]) {
          await db.query(
            `insert into asc_daily_metrics (app_id, metric_on, country, impressions, product_page_views,
                    impressions_search, impressions_browse, impressions_app_referrer, impressions_web_referrer)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (app_id, metric_on, country) do update set
               impressions = excluded.impressions, product_page_views = excluded.product_page_views,
               impressions_search = excluded.impressions_search, impressions_browse = excluded.impressions_browse,
               impressions_app_referrer = excluded.impressions_app_referrer, impressions_web_referrer = excluded.impressions_web_referrer`,
            [app.app_id, day.date, day.country, day.impressions, day.product_page_views,
             day.impressions_search, day.impressions_browse, day.impressions_app_referrer, day.impressions_web_referrer],
          );
          rowsWritten++;
        }

        // Downloads + proceeds — one call per day, so only backfill a short recent window
        // (Sales Reports lag 2 days, per 02 §5.5) rather than looping back to day one.
        if (ascVendorConfigured()) {
          for (let daysAgo = 2; daysAgo <= 9; daysAgo++) {
            const d = new Date(`${RUN_DATE}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() - daysAgo);
            const iso = d.toISOString().slice(0, 10);
            const tsv = await fetchSalesReportTsv(iso);
            if (!tsv) continue;
            const { worldwide, perCountry } = parseSalesReport(tsv, app.store_id);
            for (const [country, totals] of [["ALL", worldwide], ...perCountry.entries()]) {
              await db.query(
                `insert into asc_daily_metrics (app_id, metric_on, country, downloads_first_time, downloads_redownload, iap_units, proceeds_usd)
                 values ($1,$2,$3,$4,$5,$6,$7)
                 on conflict (app_id, metric_on, country) do update set
                   downloads_first_time = excluded.downloads_first_time, downloads_redownload = excluded.downloads_redownload,
                   iap_units = excluded.iap_units, proceeds_usd = excluded.proceeds_usd`,
                [app.app_id, iso, country, totals.downloads_first_time, totals.downloads_redownload, totals.iap_units, totals.proceeds_usd],
              );
              rowsWritten++;
            }
          }
        }
        // Hidden keywords field + promotional text — the one listing fact only ASC can see.
        // Needs an App Manager key; a Sales-role key returns null here and we move on.
        try {
          const locs = await fetchListingLocalizations(app.store_id);
          for (const loc of locs ?? []) {
            if (loc.keywords == null && loc.promotional_text == null) continue;
            await db.query(
              `update app_snapshots set keywords_field = coalesce($3, keywords_field),
                      promotional_text = coalesce($4, promotional_text)
                where id in (
                  select id from app_snapshots
                   where app_id = $1 and (locale is null or lower(replace(locale,'_','-')) = lower($2))
                   order by captured_on desc limit 1
                )`,
              [app.app_id, loc.locale.replace("_", "-"), loc.keywords, loc.promotional_text],
            );
          }
          if (locs === null && ascConfigured()) jobWarnings.push(`asc listing ${app.name}: keywords field not readable (key needs the App Manager role).`);
        } catch (err) {
          jobWarnings.push(`asc listing ${app.name}: ${err.message}`);
        }
      } catch (err) {
        jobWarnings.push(`asc_sync ${app.name}: ${err.message}`);
      }
      await bumpJob(jobId, ++done);
    }

    log(`   ${rowsWritten} row(s) written${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
    await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
    warnings.push(...jobWarnings);
  }
}

// ===========================================================================
// JOB 1d — play_sync: REAL Play search terms from the Console GCS bucket (Workstream I)
// The one capability the reference product doesn't have: measured queries with conversion
// data. Monthly files with daily rows and a 3-7 day lag; current + previous month are
// re-fetched every run and upserted, which makes the lag self-healing and the job idempotent.
// ===========================================================================
if (JOBS.includes("play_sync")) {
  const { loadServiceAccount, serviceAccountToken, listReportObjects, downloadObject, decodeUtf16, parseSearchTerms } =
    await import("../lib/stores/play-console.mjs");

  const sa = loadServiceAccount();
  const bucket = process.env.PLAY_GCS_BUCKET;
  if (!sa || !bucket) {
    warnings.push("PLAY_SERVICE_ACCOUNT_FILE / PLAY_GCS_BUCKET not set — Play real search terms are skipped. (Bucket URI comes from Play Console → Download reports → Copy Cloud Storage URI; access via Play Console's user list, NOT Cloud IAM — 02 §7.1.)");
  } else {
    const ownAndroid = trackedApps.filter((a) => a.role === "own" && a.platform === "android");
    const jobId = await startJob("play_sync", { date: RUN_DATE }, ownAndroid.length);
    const jobWarnings = [];
    let done = 0;
    let rowsWritten = 0;

    log(`1d. play_sync — ${ownAndroid.length} Android app(s)`);

    try {
      const token = DRY ? null : await serviceAccountToken(sa);

      // Current + previous month cover the posting lag.
      const months = [0, 1].map((back) => {
        const d = new Date(`${RUN_DATE}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() - back);
        return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      });

      for (const app of ownAndroid) {
        try {
          if (DRY) { done++; continue; }
          for (const month of months) {
            const name = `stats/store_performance/store_performance_${app.store_id}_${month}_traffic_source.csv`;
            const found = await listReportObjects(token, bucket, name);
            if (!found.length) continue; // month not posted yet — the lag, not an error
            const bytes = await downloadObject(token, bucket, found[0]);
            const terms = parseSearchTerms(decodeUtf16(bytes));

            for (const t of terms) {
              const res = await db.query(
                `insert into play_search_terms (package_name, day, search_term, visitors, acquisitions, conversion_rate)
                 values ($1,$2,$3,$4,$5,$6)
                 on conflict (package_name, day, search_term) do update set
                   visitors = excluded.visitors, acquisitions = excluded.acquisitions,
                   conversion_rate = excluded.conversion_rate, fetched_at = now()`,
                [t.package_name, t.day, t.search_term, t.visitors, t.acquisitions, t.conversion_rate],
              );
              rowsWritten += res.rowCount ?? 0;
            }
          }
        } catch (err) {
          jobWarnings.push(`play_sync ${app.name}: ${err.message}`);
        }
        await bumpJob(jobId, ++done);
      }
    } catch (err) {
      // Token failure degrades the whole feature for today, never the crawl.
      jobWarnings.push(`play_sync auth: ${err.message}`);
    }

    log(`   ${rowsWritten} search-term row(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
    await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
    warnings.push(...jobWarnings);
  }
}

// ===========================================================================
// JOB 2 — rank_check: THE UNIQUE-KEYWORD LOOP
// ===========================================================================
/**
 * ONE search-results fetch serves EVERY app tracking that keyword.
 *
 * A naive crawler loops over (app × keyword) pairs and fetches once per pair. This loops over
 * unique (term, platform, country) triples, fetches the results page ONCE, then extracts the
 * rank of every tracked app that appears in it — own apps and competitors together — and
 * computes difficulty from the same response.
 *
 * Getting this wrong multiplies the fetch cost by the number of tracked apps, and Apple's
 * rate limit is the ceiling on this whole product.
 */
if (JOBS.includes("rank_check")) {
  let queue = await q(
    db,
    `select k.id as keyword_id, k.term, k.term_normalized, k.platform, k.country
       from keywords k
      where exists (
              select 1 from tracked_keywords tk
                join tracked_apps ta on ta.id = tk.tracked_app_id
               where tk.keyword_id = k.id and ta.is_active)
        and not exists (
              select 1 from rankings r
                join tracked_keywords tk2 on tk2.keyword_id = k.id
                join tracked_apps ta2 on ta2.id = tk2.tracked_app_id and ta2.is_active
               where r.keyword_id = k.id and r.app_id = ta2.app_id and r.checked_on = $1)
      order by k.metrics_updated_at nulls first, k.id`,
    [RUN_DATE],
  );
  if (LIMIT) queue = queue.slice(0, LIMIT);

  const jobId = await startJob("rank_check", { date: RUN_DATE }, queue.length);
  const jobWarnings = [];
  let done = 0;
  let ranksWritten = 0;

  log(`2. rank_check — ${queue.length} unique (term, platform, country) triples`);

  for (const kw of queue) {
    if (outOfTime()) {
      jobWarnings.push(`rank_check stopped at ${done}/${queue.length} — the ${MAX_MINUTES}-minute budget ran out. The remaining keywords are the stalest, so tomorrow's run takes them first.`);
      break;
    }

    // Every tracked app on this keyword's platform is a candidate for a rank in this SERP.
    const candidates = await q(
      db,
      `select distinct ta.id as tracked_app_id, a.id as app_id, a.store_id, a.platform
         from tracked_keywords tk
         join tracked_apps ta on ta.id = tk.tracked_app_id and ta.is_active
         join apps a on a.id = ta.app_id
        where tk.keyword_id = $1
        union
        -- competitors of any app tracking this keyword get their rank for free from the
        -- same response, which is what makes the competitive buckets cost nothing
        select distinct c.id, ca.id, ca.store_id, ca.platform
          from tracked_keywords tk
          join tracked_apps own on own.id = tk.tracked_app_id and own.is_active
          join tracked_apps c on c.competitor_of = own.id and c.is_active
          join apps ca on ca.id = c.app_id
         where tk.keyword_id = $1`,
      [kw.keyword_id],
    );

    try {
      if (DRY) { done++; continue; }

      const result = kw.platform === "ios"
        ? await fetchIosSerp(kw)
        : await fetchAndroidSerp(kw);

      if (!result) { jobWarnings.push(`rank_check ${kw.term}/${kw.country}: no SERP`); await bumpJob(jobId, ++done); continue; }

      const { orderedIds, top, depth } = result;

      // --- ranks for every tracked app, from this one response -------------
      // Two round trips total, not two per app: fetch every app's previous state at once,
      // then write all the rankings rows in a single multi-row upsert.
      const relevant = candidates.filter((a) => a.platform === kw.platform);
      if (relevant.length) {
        const previous = await q(
          db,
          `select app_id, rank, last_known_rank from ranking_current
            where keyword_id = $1 and app_id = any($2::uuid[])`,
          [kw.keyword_id, relevant.map((a) => a.app_id)],
        );
        const prevByApp = new Map(previous.map((p) => [p.app_id, p]));

        const cols = 7;
        const values = [];
        const params = [];
        relevant.forEach((app, i) => {
          const idx = orderedIds.indexOf(String(app.store_id));
          const rank = idx === -1 ? null : idx + 1;
          const prev = prevByApp.get(app.app_id);
          // Carry the last known position forward so the UI can say ">200 (was #163)".
          const lastKnown = rank != null ? null : (prev?.rank ?? prev?.last_known_rank ?? null);
          const base = i * cols;
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
          params.push(app.app_id, kw.keyword_id, RUN_DATE, rank, depth, rank != null, lastKnown);
        });

        await db.query(
          `insert into rankings (app_id, keyword_id, checked_on, rank, crawl_depth, found, last_known_rank)
           values ${values.join(",")}
           on conflict (app_id, keyword_id, checked_on) do update set
             rank = excluded.rank, crawl_depth = excluded.crawl_depth,
             found = excluded.found, last_known_rank = excluded.last_known_rank,
             checked_at = now()`,
          params,
        );
        ranksWritten += relevant.length;
      }

      // --- the SERP itself, for difficulty / outliers / the icon strip -----
      await persistSerp(dbq, kw, top, RUN_DATE);

      // --- difficulty, from the response we ALREADY have. No extra call. --
      await updateKeywordSerpMetrics(dbq, kw, { top, depth });
    } catch (err) {
      // A 403 cooldown must degrade ONE keyword, not halt the crawl. And we must never write
      // a rank=null row that looks like "checked and absent" when the truth is "we could not
      // fetch or parse it" (07 §9).
      jobWarnings.push(`rank_check ${kw.term}/${kw.country}: ${err.message}`);
    }

    await bumpJob(jobId, ++done); // persist after EVERY keyword
  }

  log(`   ${done}/${queue.length} keywords, ${ranksWritten} ranking rows${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

// ===========================================================================
// JOB 3 — autocomplete: the prefix walk that feeds the popularity proxy
// ===========================================================================
if (JOBS.includes("autocomplete")) {
  const seeds = await buildSeedRoots();
  // Budget: a full 27-prefix × 16-root × 4-country sweep is ~29 hours of fetching, so the
  // prefix space is ROTATED — a slice each night, a full sweep across a week (07 §5).
  const slice = rotationSlice(seeds, LIMIT || 80);

  const jobId = await startJob("autocomplete", { date: RUN_DATE, roots: slice.length }, slice.length);
  const jobWarnings = [];
  let done = 0;
  let hits = 0;

  log(`3. autocomplete — ${slice.length} of ${seeds.length} (root, country) pairs this rotation`);

  for (const { root, country, platform } of slice) {
    if (outOfTime()) {
      jobWarnings.push(`autocomplete stopped at ${done}/${slice.length} — budget exhausted. The prefix space rotates nightly anyway, so this slice simply resumes tomorrow.`);
      break;
    }
    try {
      if (DRY) { done++; continue; }
      const suggestions = platform === "ios"
        ? await appleAutocomplete(root, country)
        : [...new Set([...(await playSuggest(root, country)), ...(await playSuggestBroad(root, country))])];

      for (let i = 0; i < suggestions.length; i++) {
        const term = suggestions[i];
        const normalized = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
        if (!normalized) continue;
        await db.query(
          `insert into autocomplete_hits (platform, country, prefix, term, term_normalized, position, observed_on)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (platform, country, prefix, term_normalized, observed_on) do update set position = excluded.position`,
          [platform, country, root, term, normalized, i, RUN_DATE],
        );
        hits++;
      }
    } catch (err) {
      jobWarnings.push(`autocomplete "${root}"/${country}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  log(`   ${hits} autocomplete observations from ${done} prefixes${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

/**
 * Seed roots per 07 §5: derived from each tracked app's own name and subtitle tokens, its
 * category, its competitors' names, and its already-tracked keywords. Prefix results are not
 * user-specific, so they are shared across workspaces.
 */
async function buildSeedRoots() {
  const rows = await q(
    db,
    `select distinct a.platform, s.country,
            coalesce(s.name, a.name) as name, s.subtitle, a.primary_genre
       from tracked_apps ta
       join apps a on a.id = ta.app_id
       left join app_snapshots s on s.app_id = a.id
      where ta.is_active`,
  );
  const kws = await q(
    db,
    `select distinct k.term, k.platform, k.country
       from tracked_keywords tk join keywords k on k.id = tk.keyword_id
       join tracked_apps ta on ta.id = tk.tracked_app_id and ta.is_active`,
  );

  const seen = new Set();
  const out = [];
  const push = (root, country, platform) => {
    const key = `${platform}:${country}:${root}`;
    if (!root || root.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push({ root, country, platform });
  };

  for (const r of rows) {
    const country = r.country ?? "us";
    for (const text of [r.name, r.subtitle, r.primary_genre]) {
      for (const w of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) push(w, country, r.platform);
    }
  }
  for (const k of kws) {
    push(k.term.toLowerCase(), k.country, k.platform);
    // "root + letter" expansion: the a-z walk that finds the long tail.
    for (const letter of "abcdefghijklmnopqrstuvwxyz") push(`${k.term.toLowerCase()} ${letter}`, k.country, k.platform);
  }
  return out;
}

/** Deterministic rotation keyed on the date, so a week of runs covers the whole space. */
function rotationSlice(items, size) {
  if (items.length <= size) return items;
  const dayIndex = Math.floor(new Date(RUN_DATE).getTime() / 86_400_000);
  const start = (dayIndex * size) % items.length;
  const out = [];
  for (let i = 0; i < size; i++) out.push(items[(start + i) % items.length]);
  return out;
}

// ===========================================================================
// JOB 4 — metrics: recompute popularity from autocomplete_hits
// ===========================================================================
if (JOBS.includes("metrics")) {
  let stale = await q(
    db,
    `select k.id as keyword_id, k.term, k.term_normalized, k.platform, k.country, k.popularity
       from keywords k
      where exists (select 1 from tracked_keywords tk join tracked_apps ta on ta.id = tk.tracked_app_id and ta.is_active
                     where tk.keyword_id = k.id)
        and (k.metrics_updated_at is null or k.metrics_updated_at < now() - interval '7 days'
             or k.popularity_estimate is null)
      order by k.metrics_updated_at nulls first`,
  );
  if (LIMIT) stale = stale.slice(0, LIMIT);

  // ONE calibration of the autocomplete proxy per run, fitted on every keyword where Apple's
  // real Search Popularity and our proxy are both known. It sharpens itself as the ASA SOV
  // report covers more terms; under 4 pairs it stays identity rather than guess a slope.
  const proxyFit = fitProxyCalibration(
    await q(
      db,
      `select popularity_proxy_raw::float as proxy, popularity::float as store from keywords
        where popularity is not null and popularity_proxy_raw is not null`,
    ),
  );
  log(`   proxy calibration: ${proxyFit.fitted ? `store = ${proxyFit.slope} x proxy + ${proxyFit.intercept} (n=${proxyFit.n})` : `identity (only ${proxyFit.n} paired observation(s))`}`);

  const jobId = await startJob("metrics", { date: RUN_DATE }, stale.length);
  const jobWarnings = [];
  let done = 0;

  // Apple Search Ads SOV cache: country -> Map(term -> 1..5 bucket), one report per country per run.
  const { asaConfigured, searchPopularity, SAP_BUCKET_TO_POPULARITY } = await import("../lib/stores/asa.mjs");
  const sapByCountry = new Map();

  log(`4. metrics — ${stale.length} keyword(s) needing a popularity refresh`);

  for (const kw of stale) {
    // Popularity carries a 7-day TTL, so this job is the most deferrable thing in the crawl.
    // It yields its remaining budget first, and the `metrics_updated_at nulls first` ordering
    // means the longest-unscored keywords are always the ones that did get done.
    if (outOfTime()) {
      jobWarnings.push(`metrics stopped at ${done}/${stale.length} — budget exhausted. Popularity has a 7-day TTL, so a deferred keyword is not stale data, just not-yet-refreshed.`);
      break;
    }
    try {
      if (DRY) { done++; continue; }

      // The prefix-depth walk is the strongest signal, on Apple's unthrottled host. Cache it
      // for 7 days (the fetch layer does that) so this is cheap on repeat runs.
      const depth = kw.platform === "ios"
        ? await suggestDepth(kw.term, kw.country, "ios")
        : await suggestDepth(kw.term, kw.country, "android", { playSuggest: (p, c) => playSuggest(p, c) });

      // Anything the autocomplete job already observed widens the breadth signal for free.
      const observed = await q1(
        db,
        `select min(position)::int as best, count(distinct prefix)::int as hits
           from autocomplete_hits
          where term_normalized = $1 and platform = $2 and country = $3
            and observed_on > $4::date - interval '30 days'`,
        [kw.term_normalized, kw.platform, kw.country, RUN_DATE],
      );

      const merged = {
        length: depth.length,
        index: depth.index,
        best: minOrNull(depth.best, observed?.best),
        hits: (depth.hits ?? 0) + (observed?.hits ?? 0),
      };

      // Real Apple Search Popularity from the Search Ads SOV report: ONE report per country
      // per run (quota is 10/day), cached in sapByCountry, covering every term Apple links to
      // the app. A real popularity value is what flips popularity_source to 'store'.
      if (kw.platform === "ios" && asaConfigured()) {
        try {
          if (!sapByCountry.has(kw.country)) {
            const ownIos = trackedApps.find((a) => a.role === "own" && a.platform === "ios");
            sapByCountry.set(
              kw.country,
              ownIos ? await searchPopularity({ adamId: ownIos.store_id, country: kw.country }) : new Map(),
            );
            log(`   asa sov ${kw.country}: ${sapByCountry.get(kw.country).size} term(s) with real popularity`);
          }
          const bucket = sapByCountry.get(kw.country).get(kw.term.toLowerCase());
          if (bucket != null) {
            await db.query(`update keywords set popularity = $2 where id = $1`, [kw.keyword_id, SAP_BUCKET_TO_POPULARITY[bucket]]);
          }
        } catch (err) {
          sapByCountry.set(kw.country, new Map()); // one failure must not re-fire per keyword
          jobWarnings.push(`asa popularity ${kw.country}: ${err.message}`);
        }
      }

      let result;
      if (kw.platform === "android") {
        const installs = await q(
          db,
          `select s.install_count from serp_results r
             join apps a on a.id = r.app_id
             left join app_snapshots s on s.app_id = a.id and s.country = $2
            where r.keyword_id = $1 and r.position <= 10 and s.install_count is not null
            order by r.captured_on desc limit 10`,
          [kw.keyword_id, kw.country],
        );
        result = popularityProxyAndroid(merged, installs.map((r) => Number(r.install_count)).filter(Boolean));
      } else {
        result = popularityProxy(merged);
      }

      // Onto Apple's scale. Uncalibrated, this proxy reads ~40 points high, which is exactly
      // why our popularity looked inflated next to every other tool.
      const est = applyProxyCalibration(result.value, proxyFit);
      const effective = popularityEffective({ popularity: kw.popularity, popularity_estimate: est });
      await db.query(
        `update keywords
            set popularity_proxy_raw = $4,
                popularity_estimate = $2,
                -- popularity_source records HOW we know: 'store' only when a real store value
                -- exists, otherwise 'proxy' so the UI can label it as ours.
                popularity_source = case when popularity is not null then 'store' else 'proxy' end,
                est_downloads_rank1 = $3,
                metrics_updated_at = now()
          where id = $1`,
        // Downloads follow the EFFECTIVE popularity (Apple's number when it exists), not the
        // proxy — otherwise the inflated proxy inflated the download estimate with it.
        [kw.keyword_id, est, estDownloadsAtRank1({ popularity: effective, platform: kw.platform }), result.value],
      );
    } catch (err) {
      jobWarnings.push(`metrics "${kw.term}"/${kw.country}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  log(`   ${done} keyword(s) rescored${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

/**
 * Declared as a `function` rather than a `const` arrow ON PURPOSE: the job blocks in this file
 * execute top-to-bottom at module scope, so a `const` helper defined below its first use sits
 * in the temporal dead zone and throws "Cannot access before initialization". Function
 * declarations hoist; arrows assigned to const do not.
 */
function minOrNull(a, b) {
  const vals = [a, b].filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

// ===========================================================================
// JOB 5 — discovery: five sources → discovered_keywords
// ===========================================================================
if (JOBS.includes("discovery")) {
  const own = trackedApps.filter((a) => a.role === "own");
  const jobId = await startJob("discovery", { date: RUN_DATE }, own.length);
  const jobWarnings = [];
  let done = 0;
  let found = 0;

  log(`5. discovery — ${own.length} own app(s), five sources`);

  for (const app of own) {
    try {
      if (DRY) { done++; continue; }
      found += await discoverFor(app, jobWarnings);
    } catch (err) {
      jobWarnings.push(`discovery ${app.name}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  log(`   ${found} discovered keyword(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

async function discoverFor(app, jobWarnings) {
  const countries = await countriesFor(app);
  const candidates = new Map(); // normalized term → source

  const addAll = (terms, source) => {
    for (const t of terms) {
      const n = String(t).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      if (n.length < 3 || n.length > 45) continue;
      if (isJunkTerm(n)) continue; // one gate for every source: no stopword-edged filler
      if (!candidates.has(n)) candidates.set(n, { term: t, source });
    }
  };

  const snap = await q1(db, `select name, subtitle, description from app_snapshots where app_id = $1 order by captured_on desc limit 1`, [app.app_id]);

  // Source A — our own listing text.
  if (snap) {
    if (app.platform === "android") {
      addAll(extractListingKeywords(snap).map((k) => k.term), "listing");
    } else {
      // Apple does not index the description, so only the indexed fields are meaningful here.
      addAll(bigrams(`${snap.name ?? ""} ${snap.subtitle ?? ""}`), "listing");
    }
  }

  // Source B — autocomplete observations already collected.
  const acRows = await q(
    db,
    `select distinct term from autocomplete_hits
      where platform = $1 and country = any($2::text[]) and observed_on > $3::date - interval '14 days'
      order by term limit 800`,
    [app.platform, countries, RUN_DATE],
  );
  addAll(acRows.map((r) => r.term), "autocomplete");

  // Source C — COMPETITOR LISTING TEXT. The cheapest high-value source, and Android-only:
  // Play indexes title + summary + full description and all of it is public, so a
  // competitor's description literally IS their keyword strategy. Apple has no equivalent.
  const competitors = await q(
    db,
    `select a.id as app_id, a.platform, a.store_id from tracked_apps c
       join apps a on a.id = c.app_id
      where c.competitor_of = $1 and c.is_active`,
    [app.tracked_app_id],
  );
  for (const c of competitors) {
    if (c.platform !== "android") continue;
    const cs = await q1(db, `select name, subtitle, description from app_snapshots where app_id = $1 order by captured_on desc limit 1`, [c.app_id]);
    if (cs) addAll(extractListingKeywords(cs, { max: 25 }).map((k) => k.term), "competitor");
  }

  // Source C½ — per-competitor AI keyword footprint (E2), refreshed WEEKLY (Mondays) to
  // keep the token cost one-day-in-seven. Add-competitor runs the same scan immediately,
  // so this only picks up drift in listings that changed since.
  if (aiEnabled() && new Date(`${RUN_DATE}T00:00:00Z`).getUTCDay() === 1) {
    const ownName = await q1(db, `select name from apps where id = $1`, [app.app_id]);
    for (const c of competitors) {
      if (outOfTime()) break;
      try {
        const cMeta = await q1(db, `select name, platform, store_id from apps where id = $1`, [c.app_id]);
        if (!cMeta) continue;
        await scanCompetitor(dbq, {
          workspaceId: app.workspace_id,
          ownTrackedAppId: app.tracked_app_id,
          ownAppName: ownName?.name ?? "",
          competitor: cMeta,
          countries,
        });
      } catch (err) {
        jobWarnings.push(`discovery competitor_ai ${app.name}: ${err.message}`);
      }
    }
  }

  // Source D — similar apps' subtitles from the SSR page (iOS), which are keyword-indexed.
  if (app.platform === "ios") {
    try {
      const ssr = await appleAppSSR(app.store_id, countries[0]);
      addAll((ssr?.similar_apps ?? []).flatMap((s) => bigrams(s.subtitle ?? "")), "competitor");
    } catch (err) {
      jobWarnings.push(`discovery similar apps ${app.name}: ${err.message}`);
    }
  }

  // Source E — category charts. Chart apps' subtitles are keyword-indexed like Source D's;
  // this source was deferred until the relevance pass below existed to gate its noise.
  // (APPLE_GENRE_IDS lives at module scope — the charts snapshot job shares it.)
  if (app.platform === "ios" && app.primary_genre) {
    const genreId = APPLE_GENRE_IDS[app.primary_genre.toLowerCase()];
    if (genreId) {
      try {
        const slug = `${app.primary_genre.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-apps`;
        const { charts } = await appleChartsSSR(countries[0], genreId, slug);
        addAll(
          charts.flatMap((c) => c.entries.filter((e) => e.subtitle).flatMap((e) => bigrams(e.subtitle))),
          "chart",
        );
      } catch (err) {
        jobWarnings.push(`discovery charts ${app.name}: ${err.message}`);
      }
    }
  }

  // Source F — AI candidate generation, the "goes wide" half: intent terms, problem phrases,
  // audience niches, long-tail qualifiers, competitor-brand derivatives. Live autocomplete
  // must CONFIRM each candidate before it earns a row — unverified model output is never
  // inserted as demand.
  if (aiEnabled() && snap) {
    try {
      const compListings = [];
      for (const c of competitors) {
        const cs = await q1(db, `select name, subtitle, description from app_snapshots where app_id = $1 order by captured_on desc limit 1`, [c.app_id]);
        if (cs) compListings.push(cs);
      }
      const tracked = await q(
        db,
        `select k.term from tracked_keywords tk join keywords k on k.id = tk.keyword_id where tk.tracked_app_id = $1`,
        [app.tracked_app_id],
      );
      const ideas = await generateKeywordCandidates({
        app: snap,
        competitors: compListings,
        existing: [...new Set([...tracked.map((t) => t.term), ...candidates.keys()])],
        max: 120,
      });
      const verified = [];
      for (const term of ideas) {
        if (outOfTime()) break;
        try {
          const suggestions = app.platform === "ios" ? await appleAutocomplete(term, countries[0]) : await playSuggest(term, countries[0]);
          if (verifyCandidate(term, suggestions)) verified.push(term);
        } catch {
          /* one bad candidate must not abandon the rest */
        }
      }
      addAll(verified, "ai");
    } catch (err) {
      jobWarnings.push(`discovery ai candidates ${app.name}: ${err.message}`);
    }
  }

  // Filter out other apps' names, which dominate autocomplete ("forge: daily mindset quotes").
  const knownApps = await q(db, `select name, developer_name, store_id from apps where platform = $1 limit 3000`, [app.platform]);
  const { appNameBlocklist, isMetadataSafe, looksLikeAppTitle } = await import("../lib/scoring/listing.mjs");
  const blocklist = appNameBlocklist(knownApps, app.store_id);

  let inserted = 0;
  for (const [normalized, { term, source }] of candidates) {
    if (looksLikeAppTitle(term)) continue;
    if (blocklist.has(normalized)) continue;

    for (const country of countries) {
      const kw = await upsertKeyword(db, { term, platform: app.platform, country });

      // Already tracked → not a discovery.
      const tracked = await q1(db, `select 1 from tracked_keywords where tracked_app_id = $1 and keyword_id = $2`, [app.tracked_app_id, kw.id]);
      if (tracked) continue;

      const opp = opportunity({
        popularity: popularityEffective(kw),
        difficulty: kw.difficulty,
        rank: null,
      });

      const res = await db.query(
        `insert into discovered_keywords (workspace_id, tracked_app_id, keyword_id, source, opportunity)
         values ($1,$2,$3,$4,$5)
         on conflict (tracked_app_id, keyword_id) do update set opportunity = excluded.opportunity
         returning (xmax = 0) as is_new`,
        [app.workspace_id, app.tracked_app_id, kw.id, source, opp],
      );
      if (res.rows[0]?.is_new) inserted++;

      // metadata safety is advisory here, surfaced in the UI rather than blocking discovery
      isMetadataSafe(term, { blocklist });
    }
  }

  // AI feature #4 — relevance (03 §6). Batched big, cached on the row, never blocks a
  // render (the column shows -- until this lands). Scores the backlog too, oldest debt
  // first by discovered_at desc within tonight's 400-row cap; the rest resumes tomorrow.
  if (aiEnabled() && snap) {
    const unscored = await q(
      db,
      `select dk.id, k.term, k.popularity, k.popularity_estimate, k.popularity_source, k.difficulty
         from discovered_keywords dk join keywords k on k.id = dk.keyword_id
        where dk.tracked_app_id = $1 and dk.relevance is null and dk.dismissed = false
        order by dk.discovered_at desc limit 600`,
      [app.tracked_app_id],
    );
    for (let i = 0; i < unscored.length; i += 100) {
      if (outOfTime()) {
        jobWarnings.push(`relevance ${app.name}: stopped at ${i}/${unscored.length} — budget exhausted; resumes tomorrow.`);
        break;
      }
      const batch = unscored.slice(i, i + 100);
      try {
        const scores = await scoreRelevance({ app: snap, terms: batch.map((b) => b.term) });
        const byTerm = new Map(scores.map((s) => [s.term.toLowerCase().trim(), s]));
        for (const row of batch) {
          const s = byTerm.get(row.term.toLowerCase().trim());
          if (!s) continue;
          const opp = opportunity({
            popularity: popularityEffective(row),
            difficulty: row.difficulty,
            rank: null,
            relevance: s.relevance,
          });
          await db.query(
            `update discovered_keywords set relevance = $2, relevance_reason = $3, opportunity = coalesce($4, opportunity) where id = $1`,
            [row.id, s.relevance, String(s.reason).slice(0, 200), opp],
          );
        }
      } catch (err) {
        jobWarnings.push(`relevance ${app.name}: ${err.message}`);
        break; // an API failure tonight would fail every batch — stop, resume tomorrow
      }
    }
  }

  return inserted;
}


// ===========================================================================
// JOB 6 — reviews
// ===========================================================================
if (JOBS.includes("reviews")) {
  const jobId = await startJob("reviews", { date: RUN_DATE }, trackedApps.length);
  const jobWarnings = [];
  let done = 0;
  let total = 0;

  log("6. reviews");
  for (const app of trackedApps) {
    for (const country of await countriesFor(app)) {
      try {
        if (DRY) continue;
        // Android rides the brittle-but-free oCPfdb endpoint (02 §6.4); a shape break
        // degrades one app's reviews for a day, never the crawl.
        const { reviews } = app.platform === "ios"
          ? await appleReviews(app.store_id, country, 1, "mostrecent")
          : await playReviews(app.store_id, country);
        let added = 0;
        for (const r of reviews) {
          const res = await db.query(
            `insert into reviews (app_id, country, store_review_id, rating, title, body, author, app_version, helpful_count, reviewed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             on conflict (app_id, country, store_review_id) do nothing
             returning id`,
            [app.app_id, country, r.store_review_id, r.rating, r.title, r.body, r.author, r.app_version, r.helpful_count, r.reviewed_at],
          );
          if (res.rowCount) added++;
        }
        total += added;

        // Daily counters so the review-spike alert has a baseline.
        const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
        await db.query(
          `insert into review_daily_counts (app_id, counted_on, new_reviews, rating_average)
           values ($1,$2,$3,$4)
           on conflict (app_id, counted_on) do update set
             new_reviews = review_daily_counts.new_reviews + excluded.new_reviews,
             rating_average = excluded.rating_average`,
          [app.app_id, RUN_DATE, added, avg == null ? null : Math.round(avg * 100) / 100],
        );
      } catch (err) {
        jobWarnings.push(`reviews ${app.name}/${country}: ${err.message}`);
      }
    }
    await bumpJob(jobId, ++done);
  }
  log(`   ${total} new review(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

// ===========================================================================
// JOB 7 — rollup: ranking_current deltas, app_daily_metrics, competitive_positions
// ===========================================================================
if (JOBS.includes("rollup")) {
  const jobId = await startJob("rollup", { date: RUN_DATE }, trackedApps.length);
  const jobWarnings = [];
  let done = 0;

  log("7. rollup");

  // --- ranking_current, with correctly-signed deltas --------------------------
  const pairs = await q(
    db,
    `select distinct app_id, keyword_id from rankings where checked_on > $1::date - interval '35 days'`,
    [RUN_DATE],
  );

  for (const { app_id, keyword_id } of pairs) {
    const history = await q(
      db,
      `select checked_on, rank, found, last_known_rank from rankings
        where app_id = $1 and keyword_id = $2 and checked_on <= $3
        order by checked_on desc limit 40`,
      [app_id, keyword_id, RUN_DATE],
    );
    if (!history.length) continue;

    const current = history[0];
    const onDate = (daysAgo) => {
      const target = new Date(`${RUN_DATE}T00:00:00Z`);
      target.setUTCDate(target.getUTCDate() - daysAgo);
      const key = target.toISOString().slice(0, 10);
      return history.find((h) => h.checked_on.toISOString().slice(0, 10) === key) ?? null;
    };

    const best = await q1(
      db,
      `select rank, checked_on from rankings where app_id = $1 and keyword_id = $2 and rank is not null
        order by rank asc, checked_on asc limit 1`,
      [app_id, keyword_id],
    );
    const first = await q1(
      db,
      `select min(checked_on) as d from rankings where app_id = $1 and keyword_id = $2 and rank is not null`,
      [app_id, keyword_id],
    );

    // delta = rank_then - rank_now. POSITIVE MEANS IMPROVED. Null if either side is missing.
    const d1 = delta(onDate(1)?.rank ?? null, current.rank);
    const d7 = delta(onDate(7)?.rank ?? null, current.rank);
    const d30 = delta(onDate(30)?.rank ?? null, current.rank);

    const within = (days) => {
      const cutoff = new Date(`${RUN_DATE}T00:00:00Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      return history.filter((h) => h.checked_on >= cutoff).map((h) => h.rank);
    };

    await db.query(
      `insert into ranking_current (app_id, keyword_id, rank, found, last_known_rank,
              delta_1d, delta_7d, delta_30d, avg_7d, avg_30d, best_rank, best_rank_on, first_ranked_on, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       on conflict (app_id, keyword_id) do update set
         rank = excluded.rank, found = excluded.found, last_known_rank = excluded.last_known_rank,
         delta_1d = excluded.delta_1d, delta_7d = excluded.delta_7d, delta_30d = excluded.delta_30d,
         avg_7d = excluded.avg_7d, avg_30d = excluded.avg_30d,
         best_rank = excluded.best_rank, best_rank_on = excluded.best_rank_on,
         first_ranked_on = excluded.first_ranked_on, checked_at = now()`,
      [
        app_id, keyword_id, current.rank, current.found, current.last_known_rank,
        d1, d7, d30, average(within(7)), average(within(30)),
        best?.rank ?? null, best?.checked_on ?? null, first?.d ?? null,
      ],
    );
  }

  // --- app_daily_metrics: visibility, share of voice, brackets, movers -------
  for (const app of trackedApps) {
    try {
      const rows = await q(
        db,
        `select k.id as keyword_id, coalesce(k.popularity_estimate, k.popularity) as popularity,
                rc.rank, tk.is_branded, rc.delta_7d
           from tracked_keywords tk
           join keywords k on k.id = tk.keyword_id
           left join ranking_current rc on rc.keyword_id = k.id and rc.app_id = $2
          where tk.tracked_app_id = $1`,
        [app.tracked_app_id, app.app_id],
      );
      if (!rows.length) continue;

      const shaped = rows.map((r) => ({ popularity: r.popularity == null ? null : Number(r.popularity), rank: r.rank, is_branded: r.is_branded }));
      const { visibility, share_of_voice } = visibilityAndShareOfVoice(shaped);
      const brackets = bracketCounts(rows.map((r) => r.rank));

      const bestRow = rows.filter((r) => r.rank != null).sort((a, b) => a.rank - b.rank)[0] ?? null;
      const moversUp = rows.filter((r) => r.delta_7d != null && r.delta_7d > 0).length;
      const moversDown = rows.filter((r) => r.delta_7d != null && r.delta_7d < 0).length;

      await db.query(
        `insert into app_daily_metrics (app_id, metric_on, visibility, share_of_voice, ranked_count,
             top3_count, top10_count, bracket_11_30, bracket_31_100, bracket_100_plus,
             best_rank, best_rank_keyword_id, movers_up, movers_down)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (app_id, metric_on) do update set
           visibility = excluded.visibility, share_of_voice = excluded.share_of_voice,
           ranked_count = excluded.ranked_count, top3_count = excluded.top3_count,
           top10_count = excluded.top10_count, bracket_11_30 = excluded.bracket_11_30,
           bracket_31_100 = excluded.bracket_31_100, bracket_100_plus = excluded.bracket_100_plus,
           best_rank = excluded.best_rank, best_rank_keyword_id = excluded.best_rank_keyword_id,
           movers_up = excluded.movers_up, movers_down = excluded.movers_down`,
        [
          app.app_id, RUN_DATE, visibility, share_of_voice, brackets.ranked,
          brackets.top3, brackets.top3 + brackets.r4_10, brackets.r11_30, brackets.r31_100,
          brackets.r100_plus, bestRow?.rank ?? null, bestRow?.keyword_id ?? null, moversUp, moversDown,
        ],
      );
    } catch (err) {
      jobWarnings.push(`rollup metrics ${app.name}: ${err.message}`);
    }
    await bumpJob(jobId, ++done);
  }

  // --- competitive_positions -------------------------------------------------
  let positions = 0;
  for (const own of trackedApps.filter((a) => a.role === "own")) {
    const competitors = await q(
      db,
      `select c.id as tracked_app_id, a.id as app_id, a.name from tracked_apps c
         join apps a on a.id = c.app_id
        where c.competitor_of = $1 and c.is_active`,
      [own.tracked_app_id],
    );
    if (!competitors.length) {
      // No tracked competitors → an EMPTY landscape with zeroed stats, not an error.
      await db.query(`delete from competitive_positions where tracked_app_id = $1`, [own.tracked_app_id]);
      continue;
    }

    const keywords = await q(
      db,
      `select k.id as keyword_id, k.difficulty, coalesce(k.popularity_estimate, k.popularity) as popularity,
              rc.rank as our_rank
         from tracked_keywords tk
         join keywords k on k.id = tk.keyword_id
         left join ranking_current rc on rc.keyword_id = k.id and rc.app_id = $2
        where tk.tracked_app_id = $1`,
      [own.tracked_app_id, own.app_id],
    );

    for (const kw of keywords) {
      const compRanks = [];
      for (const c of competitors) {
        const now = await q1(db, `select rank from ranking_current where app_id = $1 and keyword_id = $2`, [c.app_id, kw.keyword_id]);
        // The ~2-week baseline. `found` distinguishes "checked and absent" from "never
        // checked" — the threat rule needs that difference or it fires on missing history.
        const then = await q1(
          db,
          `select rank, found from rankings where app_id = $1 and keyword_id = $2 and checked_on <= $3::date - interval '14 days'
            order by checked_on desc limit 1`,
          [c.app_id, kw.keyword_id, RUN_DATE],
        );
        const best7 = await q1(
          db,
          `select min(rank) as r from rankings where app_id = $1 and keyword_id = $2 and checked_on > $3::date - interval '7 days'`,
          [c.app_id, kw.keyword_id, RUN_DATE],
        );
        compRanks.push({
          app_id: c.app_id,
          rank: now?.rank ?? null,
          rank_14d_ago: then?.rank ?? null,
          baseline_observed: then != null, // a row exists at all, whatever it says
          best_rank_7d: best7?.r ?? null,
        });
      }

      const popularity = kw.popularity == null ? null : Number(kw.popularity);
      const result = competitiveBucket({
        ourRank: kw.our_rank,
        competitors: compRanks,
        difficulty: kw.difficulty,
        popularity,
      });

      if (!result.bucket) {
        await db.query(`delete from competitive_positions where tracked_app_id = $1 and keyword_id = $2`, [own.tracked_app_id, kw.keyword_id]);
        continue;
      }

      const best = compRanks.filter((c) => c.rank != null).sort((a, b) => a.rank - b.rank)[0] ?? null;
      await db.query(
        `insert into competitive_positions (tracked_app_id, keyword_id, best_competitor_app_id,
               their_rank, our_rank, opportunity, bucket, computed_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (tracked_app_id, keyword_id) do update set
           best_competitor_app_id = excluded.best_competitor_app_id,
           their_rank = excluded.their_rank, our_rank = excluded.our_rank,
           opportunity = excluded.opportunity, bucket = excluded.bucket, computed_at = now()`,
        [
          own.tracked_app_id, kw.keyword_id, result.best_competitor ?? best?.app_id ?? null,
          result.to_rank ?? best?.rank ?? null, kw.our_rank,
          opportunity({ popularity, difficulty: kw.difficulty, rank: kw.our_rank }),
          result.bucket,
        ],
      );
      positions++;
    }
  }

  // --- auto-track ranked discoveries ----------------------------------------
  // Runs here, not in `discovery`, because it needs the ranking_current rows written above.
  // Only keywords we have MEASURED a rank for are promoted — an idea that doesn't rank is
  // never auto-tracked, so this cannot quietly fill the table with noise. Capped per app per
  // run, best rank first, so a switch flipped on a big backlog lands over several nights.
  //
  // ponytail: correct but currently inert. `rank_check` only fetches SERPs for TRACKED
  // keywords (by design — that queue is the whole crawl budget), so no discovered keyword has
  // a ranking_current row yet and this promotes nothing. It starts working the moment
  // discoveries get a rank source — the cheap one is an on-demand SERP fetch that writes a
  // rank for the discoveries someone actually opens. Do NOT "fix" this by adding discoveries
  // to the rank_check queue: hundreds of discoveries against tens of tracked keywords is a
  // multiple-x SERP-fetch bill and blows the Actions budget.
  const AUTO_TRACK_CAP = 50;
  let promoted = 0;
  for (const app of trackedApps.filter((a) => a.role === "own" && a.auto_track_ranked)) {
    try {
      if (DRY) continue;
      const ranked = await q(
        db,
        `select d.id, d.keyword_id, rc.rank from discovered_keywords d
           join ranking_current rc on rc.keyword_id = d.keyword_id and rc.app_id = $2
          where d.tracked_app_id = $1 and not d.dismissed and rc.rank is not null
          order by rc.rank asc limit $3`,
        [app.tracked_app_id, app.app_id, AUTO_TRACK_CAP],
      );
      for (const r of ranked) {
        const res = await db.query(
          `insert into tracked_keywords (workspace_id, tracked_app_id, keyword_id, source)
           values ($1,$2,$3,'suggested')
           on conflict (tracked_app_id, keyword_id) do nothing
           returning id`,
          [app.workspace_id, app.tracked_app_id, r.keyword_id],
        );
        // Dismiss either way: it is tracked now, so it is no longer a suggestion.
        await db.query(`update discovered_keywords set dismissed = true where id = $1`, [r.id]);
        if (res.rowCount) promoted++;
      }
    } catch (err) {
      jobWarnings.push(`auto-track ${app.name}: ${err.message}`);
    }
  }

  log(
    `   ${pairs.length} ranking_current row(s), ${positions} competitive position(s)` +
      `${promoted ? `, ${promoted} ranked discovery auto-tracked` : ""}` +
      `${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`,
  );
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

// ===========================================================================
// JOB 8 — alerts
// ===========================================================================
if (JOBS.includes("alerts")) {
  const jobId = await startJob("alerts", { date: RUN_DATE }, trackedApps.length);
  const jobWarnings = [];
  let fired = 0;

  log("8. alerts");

  const workspaces = await q(db, `select id, name from workspaces`);
  for (const ws of workspaces) {
    const settingsRows = await q(db, `select kind, enabled, threshold from alert_settings where workspace_id = $1`, [ws.id]);
    const settings = Object.fromEntries(settingsRows.map((r) => [r.kind, { enabled: r.enabled, threshold: r.threshold }]));
    if (!settingsRows.some((r) => r.enabled)) continue; // everything is off until turned on

    const apps = trackedApps.filter((a) => a.workspace_id === ws.id);
    for (const app of apps) {
      const rows = await q(
        db,
        `select tk.keyword_id, k.term, k.platform, k.country from tracked_keywords tk
           join keywords k on k.id = tk.keyword_id
          where tk.tracked_app_id = $1`,
        [app.tracked_app_id],
      );

      // Rating and review baselines for the two non-rank alerts.
      const ratings = await q(
        db,
        `select rating_average from app_snapshots where app_id = $1 order by captured_on desc limit 2`,
        [app.app_id],
      );
      const reviewHistory = await q(
        db,
        `select new_reviews from review_daily_counts where app_id = $1 and counted_on < $2 order by counted_on desc limit 30`,
        [app.app_id, RUN_DATE],
      );
      const todayReviews = await q1(db, `select new_reviews from review_daily_counts where app_id = $1 and counted_on = $2`, [app.app_id, RUN_DATE]);
      const competitorEvents = await q1(
        db,
        `select count(*)::int as n from activity_events e
           join tracked_apps c on c.app_id = e.app_id and c.competitor_of = $1 and c.is_active
          where e.occurred_on = $2`,
        [app.tracked_app_id, RUN_DATE],
      );

      for (const kw of rows) {
        const [todayRow, prevRow] = await q(
          db,
          `select checked_on, rank from rankings where app_id = $1 and keyword_id = $2 and checked_on <= $3
            order by checked_on desc limit 2`,
          [app.app_id, kw.keyword_id, RUN_DATE],
        );
        if (!todayRow) continue;

        const events = evaluateAlerts({
          today: todayRow,
          yesterday: prevRow,
          settings,
          ratingToday: ratings[0]?.rating_average == null ? null : Number(ratings[0].rating_average),
          ratingYesterday: ratings[1]?.rating_average == null ? null : Number(ratings[1].rating_average),
          newReviews: todayReviews?.new_reviews ?? null,
          reviewBaseline: meanStdDev(reviewHistory.map((r) => r.new_reviews)),
          competitorEvents: competitorEvents?.n ?? 0,
        });

        for (const ev of events) {
          // Deduplicate: one alert per (app, keyword, kind, day).
          const res = await db.query(
            `insert into alerts (workspace_id, app_id, keyword_id, kind, message, platform, country, from_rank, to_rank, occurred_on)
             select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
             -- $3 must be cast: keyword_id is bigint, and an untyped 0 makes Postgres infer
             -- integer for the parameter, which fails with "integer versus bigint" (42P08)
             -- the first time an alert actually fires. Latent until then.
             where not exists (select 1 from alerts where app_id = $2 and coalesce(keyword_id, 0::bigint) = coalesce($3::bigint, 0::bigint) and kind = $4 and occurred_on = $10)
             returning id`,
            [
              ws.id, app.app_id, kw.keyword_id, ev.kind,
              alertMessage(ev, app, kw), kw.platform, kw.country, ev.from_rank, ev.to_rank, RUN_DATE,
            ],
          );
          if (res.rowCount) fired++;
        }
      }
    }
  }

  // ---- one digest email per workspace per day, never one per alert ----------
  const { sendDigest } = await import("../lib/digest.mjs");
  for (const ws of workspaces) {
    const owner = await q1(
      db,
      `select u.email, u.alert_email, u.alerts_paused from users u join workspaces w on w.owner_id = u.id where w.id = $1`,
      [ws.id],
    );
    if (owner?.alerts_paused) {
      jobWarnings.push(`digest for "${ws.name}" skipped — alert emails are paused (alerts still appear in the feed).`);
      continue;
    }

    const unsent = await q(
      db,
      `select al.id, al.kind, al.message, al.platform, al.country, a.name as app_name
         from alerts al join apps a on a.id = al.app_id
        where al.workspace_id = $1 and al.occurred_on = $2 and al.emailed_at is null
        order by a.name`,
      [ws.id, RUN_DATE],
    );
    if (!unsent.length) continue;

    const result = await sendDigest({
      to: owner?.alert_email || owner?.email,
      workspaceName: ws.name,
      alerts: unsent,
      date: RUN_DATE,
    });

    if (result.sent) {
      await db.query(`update alerts set emailed_at = now() where id = any($1::bigint[])`, [unsent.map((a) => a.id)]);
      log(`   digest sent to ${owner?.alert_email || owner?.email} (${unsent.length} alerts)`);
    } else {
      // Not sending is a degraded feature, not a failed run — the alerts stay in the feed and
      // remain unsent so tomorrow's digest can pick them up once a key exists.
      jobWarnings.push(`digest for "${ws.name}" not sent: ${result.reason}`);
    }
  }

  // ---- "Your week in ASO" — one summary per workspace, Mondays only ----------
  if (new Date(`${RUN_DATE}T00:00:00Z`).getUTCDay() === 1) {
    const { sendWeekly } = await import("../lib/digest.mjs");
    for (const ws of workspaces) {
      const owner = await q1(
        db,
        `select u.email, u.alert_email, u.alerts_paused from users u join workspaces w on w.owner_id = u.id where w.id = $1`,
        [ws.id],
      );
      if (owner?.alerts_paused) continue;

      // Re-run guard: a marker row in upstream_cache means this week's report went out.
      const markerKey = `weekly-report:${ws.id}:${RUN_DATE}`;
      const already = await q1(db, `select 1 from upstream_cache where cache_key = $1`, [markerKey]);
      if (already) continue;

      const ownApps = trackedApps.filter((a) => a.workspace_id === ws.id && a.role === "own");
      const report = [];
      for (const app of ownApps) {
        const movers = await q(
          db,
          `select term, country, rank as to_rank, delta_7d,
                  (rank + delta_7d) as from_rank
             from v_tracked_keyword_rows
            where tracked_app_id = $1 and delta_7d is not null and delta_7d <> 0
            order by abs(delta_7d) desc
            limit 8`,
          [app.tracked_app_id],
        );
        const vis = await q(
          db,
          `select visibility from app_daily_metrics
            where app_id = $1 and visibility is not null
            order by metric_on desc limit 8`,
          [app.app_id],
        );
        const disc = await q1(
          db,
          `select count(*)::int as count from discovered_keywords
            where tracked_app_id = $1 and discovered_at > $2::date - 7 and not dismissed`,
          [app.tracked_app_id, RUN_DATE],
        );
        const discTop = await q(
          db,
          `select k.term from discovered_keywords d join keywords k on k.id = d.keyword_id
            where d.tracked_app_id = $1 and d.discovered_at > $2::date - 7 and not d.dismissed
            order by d.opportunity desc nulls last limit 5`,
          [app.tracked_app_id, RUN_DATE],
        );
        report.push({
          name: app.name,
          platform: app.platform,
          visibility: vis[0]?.visibility != null ? Number(vis[0].visibility) : null,
          visibility_prev: vis[7]?.visibility != null ? Number(vis[7].visibility) : null,
          movers: movers.map((m) => ({ term: m.term, country: m.country, from_rank: m.from_rank, to_rank: m.to_rank, delta: Number(m.delta_7d) })),
          discoveries: { count: disc?.count ?? 0, top: discTop.map((t) => t.term) },
        });
      }

      const result = await sendWeekly({
        to: owner?.alert_email || owner?.email,
        workspaceName: ws.name,
        weekEnd: RUN_DATE,
        apps: report,
      });
      if (result.sent) {
        await db.query(
          `insert into upstream_cache (cache_key, payload, expires_at) values ($1,'{}'::jsonb, now() + interval '8 days')
           on conflict (cache_key) do nothing`,
          [markerKey],
        );
        log(`   weekly report sent to ${owner?.alert_email || owner?.email}`);
      } else {
        jobWarnings.push(`weekly report for "${ws.name}" not sent: ${result.reason}`);
      }
    }
  }

  log(`   ${fired} alert(s) created${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
  await finishJob(jobId, jobWarnings.length ? "partial" : "done", jobWarnings);
  warnings.push(...jobWarnings);
}

/** Every message states the app, the keyword, the STORE and COUNTRY, and both ranks. */
function alertMessage(ev, app, kw) {
  const store = kw.platform === "ios" ? "App Store" : "Google Play";
  const where = `(${store} · ${kw.country.toUpperCase()})`;
  const q_ = `"${kw.term}"`;

  switch (ev.kind) {
    case "rank_drop":
      return ev.to_rank == null
        ? `${app.name} fell from #${ev.from_rank} out of the results for ${q_} ${where}`
        : `${app.name} fell from #${ev.from_rank} to #${ev.to_rank} for ${q_} ${where}`;
    case "out_of_top10":
      return ev.to_rank == null
        ? `${app.name} dropped out of the top 10 and out of the results for ${q_} ${where}`
        : `${app.name} dropped out of the top 10 (now #${ev.to_rank}) for ${q_} ${where}`;
    case "new_ranking":
      return `${app.name} started ranking at #${ev.to_rank} for ${q_} ${where}`;
    case "rank_gain":
      return `${app.name} climbed from #${ev.from_rank} to #${ev.to_rank} for ${q_} ${where}`;
    case "entered_top10":
      return `${app.name} broke into the top 10 (now #${ev.to_rank}) for ${q_} ${where}`;
    case "rating_drop":
      return `${app.name}'s average rating fell from ${ev.detail?.from} to ${ev.detail?.to} ${where}`;
    case "review_spike":
      return `${app.name} gained ${ev.detail?.count} new reviews, well above its ${ev.detail?.mean}/day average ${where}`;
    case "competitor_change":
      return `A competitor of ${app.name} shipped ${ev.detail?.events} listing change(s) ${where}`;
    default:
      return `${app.name}: ${ev.kind} for ${q_} ${where}`;
  }
}

// ===========================================================================
async function countriesFor(app) {
  const rows = await q(
    db,
    `select distinct k.country from tracked_keywords tk
       join keywords k on k.id = tk.keyword_id
      where tk.tracked_app_id = $1 and k.platform = $2`,
    [app.tracked_app_id, app.platform],
  );
  // A competitor has no tracked keywords of its own, so it inherits the parent's markets.
  if (!rows.length && app.competitor_of) {
    const parent = await q(
      db,
      `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
        where tk.tracked_app_id = $1 and k.platform = $2`,
      [app.competitor_of, app.platform],
    );
    if (parent.length) return parent.map((r) => r.country);
  }
  return rows.length ? rows.map((r) => r.country) : ["us"];
}

async function finalReport() {
  const pruned = await pruneCache();
  const stats = fetchStats();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const minutes = (Number(seconds) / 60).toFixed(1);
  log(`\n${"─".repeat(70)}`);
  log(`Crawl finished in ${seconds}s (${minutes} min).`);
  if (MAX_MINUTES) {
    // GitHub bills whole minutes, rounded up, per job — so report what this run actually costs.
    const billed = Math.ceil(Number(minutes));
    log(`  budget ${MAX_MINUTES} min (governs the keyword-scaling jobs) · ran ${minutes} min · billed ${billed} → ~${billed * 30} min/month`);
    if (outOfTime()) {
      // Be precise about what the ceiling does and does not cover, or the number above looks
      // like the budget simply failed.
      log(`  ⚠ budget exhausted — rank_check/autocomplete/metrics yielded; unfinished work resumes tomorrow, oldest first.`);
      log(`    rollup, reviews and alerts still ran: they scale with APP count, not keyword count,`);
      log(`    and skipping rollup would leave the dashboard inconsistent with the ranks just written.`);
    }
  }
  for (const [bucketName, s] of Object.entries(stats)) {
    log(`  ${bucketName.padEnd(18)} ${String(s.calls).padStart(4)} calls  ${s.throttled} throttled${s.cooling_down ? "  (COOLING DOWN)" : ""}`);
  }
  if (pruned) log(`  pruned ${pruned} expired cache row(s)`);

  if (warnings.length) {
    log(`\n${warnings.length} warning(s) — the run completed anyway:`);
    for (const w of warnings.slice(0, 25)) log(`  · ${w}`);
    if (warnings.length > 25) log(`  … and ${warnings.length - 25} more (see crawl_jobs.warnings)`);
  } else {
    log("\nNo warnings.");
  }
}

await finalReport();
await db.end().catch(() => {});
