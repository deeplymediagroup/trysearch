/**
 * Everything that moves Apple Ads Platform API insights into the database.
 *
 *   refreshAsaPopularity   — the corpus: upsert asa_search_terms, write real 1–100 popularity
 *                            onto matching keywords. The calibration in scores.mjs learns from
 *                            these pairs.
 *   refreshImpressionShare — per own-app ad visibility by term into asa_impression_share.
 *                            Apple keeps only ~4 weekly periods, so this ACCUMULATES nightly.
 *   calibrationCandidates  — corpus terms with a real Apple number but no autocomplete proxy
 *                            yet; the metrics job scores a stratified sample each night so the
 *                            proxy fit grows by hundreds of pairs instead of only the tracked-
 *                            keyword overlap.
 *
 * Shared by the nightly crawl (metrics job), scripts/recalibrate-popularity.mjs, and
 * scripts/backfill-asa-history.mjs. One Platform API query per country per dataset — no
 * per-keyword calls, no report quotas.
 */
import { q } from "./db.mjs";
import { normalizeTerm } from "./scoring/text.mjs";
import { searchTermPopularity, impressionShare } from "./stores/asa.mjs";

/**
 * Apple's insights genre enum from a store genre name: "Health & Fitness" → "HEALTH_FITNESS".
 * Naive on purpose — Apple's combined buckets (e.g. PRODUCTIVITY_UTILITIES) can't be derived,
 * so ASA_STP_GENRES overrides everything when the guess misses.
 */
export function appleGenreEnum(primaryGenre) {
  return String(primaryGenre ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Fallback genre list if Apple demands a genre filter on the corpus query. */
export async function genresFor(db) {
  const env = (process.env.ASA_STP_GENRES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  const rows = await q(
    db,
    `select distinct a.primary_genre from tracked_apps ta join apps a on a.id = ta.app_id
      where a.platform = 'ios' and ta.is_active and a.primary_genre is not null`,
  );
  return rows.map((r) => appleGenreEnum(r.primary_genre)).filter(Boolean);
}

/** Distinct countries of tracked iOS keywords — every ASA dataset is fetched per country. */
async function trackedCountries(db) {
  return q(
    db,
    `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
      where k.platform = 'ios'`,
  );
}

/**
 * Upserts one country's corpus rows into asa_search_terms, batched. Apple republishes a
 * period unchanged, so conflicts just refresh the numbers. Exported for the history
 * backfill script. Returns the latest period present in the rows.
 */
export async function upsertCorpus(db, country, rows) {
  const clean = rows
    .map((r) => ({
      period: r.week ?? r.month ?? null,
      genre: r.genre ?? "ALL",
      term: normalizeTerm(r.searchTerm),
      rank: r.rankInGenre ?? null,
      popGenre: r.searchPopularityInGenre ?? null,
      pop100: r.searchPopularity1to100 ?? null,
      pop5: r.searchPopularity1to5 ?? null,
    }))
    .filter((r) => r.term && r.period);
  for (let i = 0; i < clean.length; i += 500) {
    const batch = clean.slice(i, i + 500);
    const values = [];
    const params = [];
    batch.forEach((r, j) => {
      const o = j * 8;
      values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`);
      params.push(r.period, String(country).toLowerCase(), r.genre, r.term, r.rank, r.popGenre, r.pop100, r.pop5);
    });
    await db.query(
      `insert into asa_search_terms
         (period_start, country, genre, term_normalized, rank_in_genre, popularity_in_genre, popularity_1_100, popularity_1_5)
       values ${values.join(",")}
       on conflict (period_start, country, genre, term_normalized) do update set
         rank_in_genre = excluded.rank_in_genre,
         popularity_in_genre = excluded.popularity_in_genre,
         popularity_1_100 = excluded.popularity_1_100,
         popularity_1_5 = excluded.popularity_1_5,
         fetched_at = now()`,
      params,
    );
  }
  // Key later reads on the period the ROWS actually carry — Apple labels each row with its
  // week, and trusting our requested window start instead would misfile everything if the
  // two ever disagree.
  const period = clean.reduce((m, r) => (r.period > m ? r.period : m), "");
  return { count: clean.length, period };
}

/**
 * Apple's number onto every matching iOS keyword (tracked or discovered — a real value is a
 * real value). A term can sit in several genres; its 1–100 country-wide popularity is the
 * same either way, max() just collapses the duplicates.
 */
export async function applyCorpusToKeywords(db, country, period) {
  const updated = await db.query(
    `update keywords k
        set popularity = s.pop, popularity_source = 'store'
       from (select term_normalized, max(popularity_1_100) as pop
               from asa_search_terms
              where country = $1 and period_start = $2 and popularity_1_100 is not null
              group by term_normalized) s
      where k.platform = 'ios' and k.country = $1 and k.term_normalized = s.term_normalized`,
    [String(country).toLowerCase(), period],
  );
  return updated.rowCount ?? 0;
}

/**
 * @param db  a connected pg client (lib/db.mjs connect())
 * @returns {Promise<{countries: number, corpusRows: number, applied: number, warnings: string[]}>}
 */
export async function refreshAsaPopularity(db, { log = () => {} } = {}) {
  const out = { countries: 0, corpusRows: 0, applied: 0, warnings: [] };
  const genres = await genresFor(db);

  for (const { country } of await trackedCountries(db)) {
    let corpus;
    try {
      corpus = await searchTermPopularity({ country, genres });
    } catch (err) {
      out.warnings.push(`asa popularity ${country}: ${err.message.slice(0, 200)}`);
      continue;
    }
    if (!corpus.rows.length) {
      out.warnings.push(`asa popularity ${country}: Apple returned no rows for the last 3 weekly periods`);
      continue;
    }
    if (corpus.truncated) out.warnings.push(`asa popularity ${country}: corpus truncated at page cap — raise maxPages if this persists`);
    out.countries++;

    const { count, period } = await upsertCorpus(db, country, corpus.rows);
    out.corpusRows += count;
    const applied = await applyCorpusToKeywords(db, country, period);
    out.applied += applied;
    log(`   asa popularity ${country}: ${count} corpus row(s) for week of ${period}, ${applied} keyword(s) got Apple's real number`);
  }

  return out;
}

/**
 * Impression share for every own iOS app in every tracked country. Nightly accumulation is
 * the history strategy: Apple only serves ~4 weekly periods, so a missed month is gone.
 *
 * @returns {Promise<{rows: number, warnings: string[]}>}
 */
export async function refreshImpressionShare(db, { log = () => {} } = {}) {
  const out = { rows: 0, warnings: [] };
  const own = await q(
    db,
    `select distinct a.store_id from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.role = 'own' and a.platform = 'ios' and ta.is_active`,
  );

  for (const { country } of await trackedCountries(db)) {
    for (const { store_id } of own) {
      let share;
      try {
        share = await impressionShare({ adamId: store_id, country });
      } catch (err) {
        out.warnings.push(`impression share ${country}: ${err.message.slice(0, 200)}`);
        continue;
      }
      if (!share.rows.length) continue; // no ads running on this storefront — not an error

      for (const r of share.rows) {
        const term = normalizeTerm(r.searchTerm);
        if (!term) continue;
        await db.query(
          `insert into asa_impression_share
             (period_start, country, adam_id, term_normalized, low_share, high_share, share_rank, popularity_1_5)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (period_start, country, adam_id, term_normalized) do update set
             low_share = excluded.low_share, high_share = excluded.high_share,
             share_rank = excluded.share_rank, popularity_1_5 = excluded.popularity_1_5,
             fetched_at = now()`,
          [r.week ?? share.period, String(country).toLowerCase(), String(store_id), term,
           r.lowImpressionShare ?? null, r.highImpressionShare ?? null, r.rank ?? null, r.searchPopularity1to5 ?? null],
        );
        out.rows++;
      }
      log(`   impression share ${country}: ${share.rows.length} term(s) for week of ${share.period}`);
    }
  }
  return out;
}

/**
 * Evenly-spaced picks across a sorted range — deterministic, no RNG (crawl scripts must
 * stay replayable). Sorting by popularity and sampling by index IS the stratification: the
 * calibration fit needs pairs across the whole 1–100 range, not 25 near-identical top terms.
 */
export function stratifiedSample(rows, size, key = "pop") {
  if (rows.length <= size) return [...rows];
  const sorted = [...rows].sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0));
  const picks = [];
  for (let i = 0; i < size; i++) {
    picks.push(sorted[Math.round((i * (sorted.length - 1)) / (size - 1))]);
  }
  return [...new Set(picks)]; // rounding can double-pick at small n
}

/**
 * Corpus terms with a real Apple popularity but no proxied keyword row yet — the raw
 * material for growing the calibration fit. Stratified so each night's sample spans the
 * whole popularity range.
 */
export async function calibrationCandidates(db, { limit = 25 } = {}) {
  const rows = await q(
    db,
    `select s.term_normalized as term, s.country, max(s.popularity_1_100) as pop
       from asa_search_terms s
      where s.period_start = (select max(period_start) from asa_search_terms)
        and s.popularity_1_100 is not null
        -- metrics_updated_at, not popularity_proxy_raw: a term autocomplete never suggests
        -- has a legitimately null proxy, and must count as attempted or it is re-sampled
        -- every night forever.
        and not exists (select 1 from keywords k
                         where k.term_normalized = s.term_normalized and k.platform = 'ios'
                           and k.country = s.country and k.metrics_updated_at is not null)
      group by s.term_normalized, s.country`,
  );
  return stratifiedSample(rows.map((r) => ({ ...r, pop: Number(r.pop) })), limit);
}
