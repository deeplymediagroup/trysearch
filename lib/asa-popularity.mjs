/**
 * Fetches Apple's search-term popularity corpus (Apple Ads Platform API insights) and
 * applies it, in two writes:
 *
 *   1. upsert the raw corpus into asa_search_terms — one row per (period, country, genre,
 *      term). This is the ground truth everything else learns from, kept verbatim.
 *   2. write searchPopularity1to100 onto every matching iOS keyword: popularity = Apple's
 *      real number, popularity_source = 'store'. The proxy calibration in the metrics job
 *      then fits our autocomplete proxy onto Apple's scale using these pairs — so the more
 *      terms Apple publishes, the better OUR estimates get on the terms Apple doesn't.
 *
 * Shared by the nightly crawl (metrics job) and scripts/recalibrate-popularity.mjs.
 * One Platform API query per country per run — no per-keyword calls, no report quotas.
 */
import { q } from "./db.mjs";
import { normalizeTerm } from "./scoring/text.mjs";
import { searchTermPopularity } from "./stores/asa.mjs";

/**
 * Fallback genre list if Apple demands a genre filter: the tracked apps' own genres mapped
 * onto Apple's enum spelling ("Health & Fitness" → "HEALTH_FITNESS"), overridable with
 * ASA_STP_GENRES=GENRE_ONE,GENRE_TWO when the naive mapping misses Apple's actual name.
 */
async function genresFor(db) {
  const env = (process.env.ASA_STP_GENRES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  const rows = await q(
    db,
    `select distinct a.primary_genre from tracked_apps ta join apps a on a.id = ta.app_id
      where a.platform = 'ios' and ta.is_active and a.primary_genre is not null`,
  );
  return rows
    .map((r) => String(r.primary_genre).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean);
}

/**
 * @param db  a connected pg client (lib/db.mjs connect())
 * @returns {Promise<{countries: number, corpusRows: number, applied: number, warnings: string[]}>}
 */
export async function refreshAsaPopularity(db, { log = () => {} } = {}) {
  const out = { countries: 0, corpusRows: 0, applied: 0, warnings: [] };

  const countries = await q(
    db,
    `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
      where k.platform = 'ios'`,
  );
  const genres = await genresFor(db);

  for (const { country } of countries) {
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

    // 1. The raw corpus, batched. Apple republishes a period unchanged, so conflicts just
    // refresh the numbers.
    const clean = corpus.rows
      .map((r) => ({
        period: r.week ?? r.month ?? corpus.period,
        genre: r.genre ?? "ALL",
        term: normalizeTerm(r.searchTerm),
        rank: r.rankInGenre ?? null,
        popGenre: r.searchPopularityInGenre ?? null,
        pop100: r.searchPopularity1to100 ?? null,
        pop5: r.searchPopularity1to5 ?? null,
      }))
      .filter((r) => r.term);
    // Key later reads on the period the ROWS actually carry — Apple labels each row with its
    // week, and trusting our requested window start instead would misfile everything if the
    // two ever disagree.
    const period = clean.reduce((m, r) => (r.period > m ? r.period : m), "");
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
    out.corpusRows += clean.length;

    // 2. Apple's number onto every matching iOS keyword (tracked or discovered — a real
    // value is a real value). A term can sit in several genres; its 1–100 country-wide
    // popularity is the same either way, max() just collapses the duplicates.
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
    out.applied += updated.rowCount ?? 0;
    log(`   asa popularity ${country}: ${clean.length} corpus row(s) for week of ${period}, ${updated.rowCount} keyword(s) got Apple's real number`);
  }

  return out;
}
