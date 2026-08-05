/**
 * Rescores difficulty for every keyword from the SERP rows already in the database.
 *
 * `node scripts/rescore-difficulty.mjs` — run it after changing the difficulty formula, so the
 * stored values match the current code without waiting a night or refetching a single SERP.
 * Zero upstream calls: it reads serp_results, recomputes, and writes keywords.difficulty.
 */
import { connect, q } from "../lib/db.mjs";
import { difficulty, serpOutlier } from "../lib/scoring/scores.mjs";

const db = await connect();
const rows = await q(
  db,
  `select k.id as keyword_id, k.term, k.platform, k.serp_depth, k.difficulty as old_difficulty,
          k.difficulty_parts,
          (select json_agg(json_build_object('store_id', a.store_id, 'name', a.name,
                                             'rating_count', sr.rating_count) order by sr.position)
             from serp_results sr join apps a on a.id = sr.app_id
            where sr.keyword_id = k.id
              and sr.captured_on = (select max(captured_on) from serp_results where keyword_id = k.id)
              and sr.position <= 10) as top
     from keywords k
    where exists (select 1 from serp_results sr where sr.keyword_id = k.id)`,
);

let changed = 0;
let moved = 0;
for (const r of rows) {
  if (!r.top?.length) continue;
  const diff = difficulty({ top: r.top, term: r.term, serpDepth: r.serp_depth, platform: r.platform });
  if (diff.value == null) continue;
  const outlier = serpOutlier({ top: r.top, platform: r.platform });
  // difficulty_parts also carries the beatable evidence, which this script does not recompute,
  // so the existing keys are preserved and only the difficulty components are replaced.
  const parts = { ...(r.difficulty_parts ?? {}), ...diff.parts, outlier: outlier.apps };
  await q(db, `update keywords set difficulty = $2, difficulty_parts = $3::jsonb where id = $1`, [
    r.keyword_id,
    diff.value,
    JSON.stringify(parts),
  ]);
  changed++;
  if (r.old_difficulty != null && Math.abs(Number(r.old_difficulty) - diff.value) >= 10) moved++;
}
console.log(`rescored ${changed} keyword(s) from stored SERPs; ${moved} moved by 10+ points`);
await db.end();
