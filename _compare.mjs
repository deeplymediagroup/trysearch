/**
 * Before/after for the popularity + difficulty changes, on the REAL stored SERPs.
 * Read-only: recomputes in memory and prints, writes nothing.
 */
import { connect, q } from "./lib/db.mjs";
import { difficulty, popularityEffective, fitProxyCalibration, applyProxyCalibration } from "./lib/scoring/scores.mjs";

const db = await connect();

const fit = fitProxyCalibration(
  await q(db, `select popularity_estimate::float as proxy, popularity::float as store from keywords
                where popularity is not null and popularity_estimate is not null and popularity_source='store'`),
);
console.log("proxy fit:", fit);

const rows = await q(db, `
  select k.id, k.term, k.country, k.platform, k.popularity, k.popularity_estimate, k.difficulty,
         (select json_agg(json_build_object('name', a.name, 'rating_count', sr.rating_count) order by sr.position)
            from serp_results sr join apps a on a.id = sr.app_id
           where sr.keyword_id = k.id
             and sr.captured_on = (select max(captured_on) from serp_results where keyword_id = k.id)
             and sr.position <= 10) as top
    from tracked_keywords tk join keywords k on k.id = tk.keyword_id
   where k.country = 'us'
   order by k.term`);

const pad = (v, n) => String(v ?? "—").padEnd(n).slice(0, n);
console.log(`\n${pad("keyword", 32)}${pad("apple", 6)}${pad("pop_old", 8)}${pad("pop_new", 8)}${pad("dif_old", 8)}${pad("dif_new", 8)}basis`);
for (const r of rows) {
  const popOld = r.popularity_estimate ?? r.popularity ?? null;
  const calibrated = applyProxyCalibration(r.popularity_estimate, fit);
  const popNew = popularityEffective({ popularity: r.popularity, popularity_estimate: calibrated });
  const d = r.top ? difficulty({ top: r.top, term: r.term, platform: r.platform }) : { value: null, parts: null };
  console.log(
    pad(r.term, 32) + pad(r.popularity, 6) + pad(popOld, 8) + pad(popNew, 8) +
    pad(r.difficulty, 8) + pad(d.value, 8) + (d.parts?.leadersBasis ?? ""),
  );
}
await db.end();
