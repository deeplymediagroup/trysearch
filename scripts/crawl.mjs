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
  appleSearchRanked,
  appleLookup,
  appleAppSSR,
  appleReviews,
  appleAutocomplete,
  suggestDepth,
  appleInAppPurchases,
} from "../lib/stores/apple.mjs";
import { playSearchRanked, playAppDetail, playSuggest, playSuggestBroad, extractListingKeywords } from "../lib/stores/play.mjs";
import {
  difficulty,
  serpOutlier,
  beatable,
  popularityProxy,
  popularityProxyAndroid,
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

const ALL_JOBS = ["app_snapshot", "rank_check", "autocomplete", "metrics", "discovery", "reviews", "rollup", "alerts"];
const JOBS = has("--all") || !arg("--jobs") ? ALL_JOBS : arg("--jobs").split(",").map((s) => s.trim()).filter(Boolean);
const RUN_DATE = arg("--date") ?? new Date().toISOString().slice(0, 10);
const LIMIT = Number(arg("--limit", "0")) || 0;
const DRY = has("--dry");

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

log(`\ntrysearch crawl — ${RUN_DATE}`);
log(`jobs: ${JOBS.join(", ")}${DRY ? "  (DRY RUN — no upstream fetches)" : ""}\n`);

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
          a.id as app_id, a.platform, a.store_id, a.name
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
      for (const app of candidates) {
        if (app.platform !== kw.platform) continue;
        const idx = orderedIds.indexOf(String(app.store_id));
        const rank = idx === -1 ? null : idx + 1;

        const last = await q1(db, `select rank, last_known_rank from ranking_current where app_id = $1 and keyword_id = $2`, [app.app_id, kw.keyword_id]);
        const lastKnown = rank != null ? null : (last?.rank ?? last?.last_known_rank ?? null);

        await db.query(
          `insert into rankings (app_id, keyword_id, checked_on, rank, crawl_depth, found, last_known_rank)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (app_id, keyword_id, checked_on) do update set
             rank = excluded.rank, crawl_depth = excluded.crawl_depth,
             found = excluded.found, last_known_rank = excluded.last_known_rank,
             checked_at = now()`,
          [app.app_id, kw.keyword_id, RUN_DATE, rank, depth, rank != null, lastKnown],
        );
        ranksWritten++;
      }

      // --- the SERP itself, for difficulty / outliers / the icon strip -----
      await persistSerp(kw, top);

      // --- difficulty, from the response we ALREADY have. No extra call. --
      const diff = difficulty({ top: top.slice(0, 10), term: kw.term, serpDepth: depth, platform: kw.platform });
      const outlier = serpOutlier({ top: top.slice(0, 10), platform: kw.platform });
      const beat = beatable({ top: top.slice(0, 10), term: kw.term, platform: kw.platform });

      await db.query(
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

async function fetchIosSerp(kw) {
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

async function fetchAndroidSerp(kw) {
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

async function persistSerp(kw, top) {
  for (const row of top) {
    if (!row.store_id) continue;
    const appId = await upsertApp(db, {
      platform: kw.platform,
      store_id: row.store_id,
      name: row.name ?? `(app ${row.store_id})`,
      ...(row.meta ?? {}),
    });
    await db.query(
      `insert into serp_results (keyword_id, captured_on, position, app_id, rating_count, rating_average, title_match)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (keyword_id, captured_on, position) do update set
         app_id = excluded.app_id, rating_count = excluded.rating_count,
         rating_average = excluded.rating_average, title_match = excluded.title_match`,
      [kw.keyword_id, RUN_DATE, row.position, appId, row.rating_count, row.rating_average, titleMatchOf(row.name, kw.term)],
    );
  }
}

function titleMatchOf(name, term) {
  if (!name) return null;
  const bag = new Set(String(name).normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const words = String(term).normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => bag.has(w));
}

// ===========================================================================
// JOB 3 — autocomplete: the prefix walk that feeds the popularity proxy
// ===========================================================================
if (JOBS.includes("autocomplete")) {
  const seeds = await buildSeedRoots();
  // Budget: a full 27-prefix × 16-root × 4-country sweep is ~29 hours of fetching, so the
  // prefix space is ROTATED — a slice each night, a full sweep across a week (07 §5).
  const slice = rotationSlice(seeds, LIMIT || 40);

  const jobId = await startJob("autocomplete", { date: RUN_DATE, roots: slice.length }, slice.length);
  const jobWarnings = [];
  let done = 0;
  let hits = 0;

  log(`3. autocomplete — ${slice.length} of ${seeds.length} (root, country) pairs this rotation`);

  for (const { root, country, platform } of slice) {
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

  const jobId = await startJob("metrics", { date: RUN_DATE }, stale.length);
  const jobWarnings = [];
  let done = 0;

  log(`4. metrics — ${stale.length} keyword(s) needing a popularity refresh`);

  for (const kw of stale) {
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

      const est = result.value;
      await db.query(
        `update keywords
            set popularity_estimate = $2,
                -- popularity_source records HOW we know: 'store' only when a real store value
                -- exists, otherwise 'proxy' so the UI can label it as ours.
                popularity_source = case when popularity is not null then 'store' else 'proxy' end,
                est_downloads_rank1 = $3,
                metrics_updated_at = now()
          where id = $1`,
        [kw.keyword_id, est, estDownloadsAtRank1({ popularity: est ?? kw.popularity, platform: kw.platform })],
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
      order by term limit 400`,
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

  // Source D — similar apps' subtitles from the SSR page (iOS), which are keyword-indexed.
  if (app.platform === "ios") {
    try {
      const ssr = await appleAppSSR(app.store_id, countries[0]);
      addAll((ssr?.similar_apps ?? []).flatMap((s) => bigrams(s.subtitle ?? "")), "competitor");
    } catch (err) {
      jobWarnings.push(`discovery similar apps ${app.name}: ${err.message}`);
    }
  }

  // Source E — charts would go here; deferred because the chart→keyword mapping needs the
  // AI relevance pass to be worth the rows. Autocomplete already covers the same ground.

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
  return inserted;
}

function bigrams(text) {
  const words = String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const out = [...words];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
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
    if (app.platform !== "ios") { await bumpJob(jobId, ++done); continue; } // Play reviews need Console credentials
    for (const country of await countriesFor(app)) {
      try {
        if (DRY) continue;
        const { reviews } = await appleReviews(app.store_id, country, 1, "mostrecent");
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

  log(`   ${pairs.length} ranking_current row(s), ${positions} competitive position(s)${jobWarnings.length ? `, ${jobWarnings.length} warning(s)` : ""}`);
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
             where not exists (select 1 from alerts where app_id = $2 and coalesce(keyword_id,0) = coalesce($3,0) and kind = $4 and occurred_on = $10)
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

  log(`\n${"─".repeat(70)}`);
  log(`Crawl finished in ${seconds}s.`);
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
