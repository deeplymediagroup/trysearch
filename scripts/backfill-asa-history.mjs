/**
 * `node scripts/backfill-asa-history.mjs [maxWeeks]`
 *
 * One-shot history backfill of Apple's search-term popularity corpus: Apple keeps 65 weekly
 * periods, the nightly crawl only ever fetches the latest, so this fills asa_search_terms
 * backwards and every keyword's "Apple demand trend" chart gets its history in one run.
 *
 * Resumable and idempotent: weeks already in the table are skipped, so a rate-limited run
 * (Apple 429s) just gets re-run. Newest weeks first — the most useful history lands first.
 */
import { loadEnv } from "./env.mjs";
import { connect, q } from "../lib/db.mjs";
import { asaConfigured, searchTermPopularity, lastFullWeek } from "../lib/stores/asa.mjs";
import { upsertCorpus, applyCorpusToKeywords, genresFor } from "../lib/asa-popularity.mjs";

loadEnv(); // asaConfigured() reads process.env BEFORE connect() would have loaded it

const MAX_WEEKS = Math.min(Number(process.argv[2] ?? 65), 65);

if (!asaConfigured()) {
  console.error("ASA env vars missing — run `node scripts/probe-asa-popularity.mjs` first.");
  process.exit(1);
}

const db = await connect();
const countries = await q(
  db,
  `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
    where k.platform = 'ios'`,
);
const genres = await genresFor(db);
const have = new Set(
  (await q(db, `select distinct period_start::text as p, country from asa_search_terms`)).map((r) => `${r.p}:${r.country}`),
);

let fetched = 0;
for (const { country } of countries) {
  for (let weeksBack = 0; weeksBack < MAX_WEEKS; weeksBack++) {
    // Skip before spending an API call — a resumed run flies through completed weeks.
    if (have.has(`${lastFullWeek(new Date(), weeksBack).start}:${country}`)) continue;
    let corpus;
    try {
      corpus = await searchTermPopularity({ country, genres, weeksBack });
    } catch (err) {
      console.log(`${country} week -${weeksBack}: ${err.message.slice(0, 120)}`);
      if (err.status === 429) {
        console.log("Rate limited — stop here and re-run later; completed weeks are skipped.");
        process.exit(2);
      }
      continue;
    }
    if (!corpus.rows.length) {
      console.log(`${country} week -${weeksBack}: no rows (before Apple's history horizon?)`);
      continue;
    }
    if (have.has(`${corpus.period}:${country}`)) {
      console.log(`${country} week of ${corpus.period}: already stored, skipped`);
      continue;
    }
    const { count, period } = await upsertCorpus(db, country, corpus.rows);
    fetched++;
    console.log(`${country} week of ${period}: ${count} row(s)`);
  }
  // Keywords always take the NEWEST stored week — never whatever week this run happened to
  // fetch first, which on a resumed run can be older than what's already applied.
  const newest = (await q(db, `select max(period_start)::text as p from asa_search_terms where country = $1`, [country]))[0]?.p;
  if (newest) {
    const applied = await applyCorpusToKeywords(db, country, newest);
    console.log(`${country}: ${applied} keyword(s) updated from the newest stored week (${newest})`);
  }
}

console.log(`\nBackfill done — ${fetched} new week/country period(s) stored.`);
await db.end();
