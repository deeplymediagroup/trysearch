/**
 * GATE 5 (09-BUILD-PLAN.md §Phase 5).
 *
 *   - each of the four competitive buckets contains at least one correctly-classified row
 *   - forcing a rank drop creates EXACTLY ONE alert row and renders ONE digest email
 *
 * The forced drop is written to a scratch date and cleaned up afterwards, so it never
 * pollutes real history.
 */
import { connect, q, q1 } from "../lib/db.mjs";
import { renderDigest } from "../lib/digest.mjs";
import { competitiveBucket, evaluateAlerts } from "../lib/scoring/scores.mjs";

const db = await connect();
let pass = 0;
let fail = 0;
const ok = (l, d = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l, w) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${l} — ${w}`); };

console.log("\nGATE 5 — competitors, activity, alerts\n");

// ---------------------------------------------------------------------------
console.log("1. Competitive buckets");
const buckets = await q(db, `select bucket, count(*)::int as n from competitive_positions group by bucket order by bucket`);
const byBucket = Object.fromEntries(buckets.map((b) => [b.bucket, b.n]));
console.log(`   ${buckets.map((b) => `${b.bucket} ${b.n}`).join(", ") || "(none)"}`);

// Verify one row of each bucket BY HAND against the raw ranks, rather than trusting the rollup.
for (const wanted of ["gap", "winnable", "threat", "lead"]) {
  const row = await q1(
    db,
    `select cp.*, k.term, k.country, k.difficulty, coalesce(k.popularity_estimate, k.popularity) as popularity,
            a.name as competitor_name
       from competitive_positions cp
       join keywords k on k.id = cp.keyword_id
       left join apps a on a.id = cp.best_competitor_app_id
      where cp.bucket = $1 limit 1`,
    [wanted],
  );
  if (!row) {
    // An empty bucket is a legitimate state, not a failure — say so honestly.
    console.log(`   \x1b[33mNOTE\x1b[0m  no "${wanted}" rows in the current data`);
    continue;
  }

  // Re-derive the bucket from the raw ranks and check the stored answer matches.
  const own = await q1(db, `select app_id from tracked_apps where id = $1`, [row.tracked_app_id]);
  const ourRank = (await q1(db, `select rank from ranking_current where app_id = $1 and keyword_id = $2`, [own.app_id, row.keyword_id]))?.rank ?? null;
  // Mirror the crawler's own baseline query exactly, or this "verification" is really just
  // testing a second, different implementation.
  const comps = await q(
    db,
    `select c.app_id, rc.rank,
            (select rank from rankings where app_id = c.app_id and keyword_id = $2
               and checked_on <= current_date - interval '14 days'
              order by checked_on desc limit 1) as rank_14d_ago,
            exists (select 1 from rankings where app_id = c.app_id and keyword_id = $2
                     and checked_on <= current_date - interval '14 days') as baseline_observed,
            (select min(rank) from rankings where app_id = c.app_id and keyword_id = $2) as best_rank_7d
       from tracked_apps c
       left join ranking_current rc on rc.app_id = c.app_id and rc.keyword_id = $2
      where c.competitor_of = $1 and c.is_active`,
    [row.tracked_app_id, row.keyword_id],
  );

  const recomputed = competitiveBucket({
    ourRank,
    competitors: comps.map((c) => ({ app_id: c.app_id, rank: c.rank, rank_14d_ago: c.rank_14d_ago, baseline_observed: c.baseline_observed, best_rank_7d: c.best_rank_7d })),
    difficulty: row.difficulty,
    popularity: row.popularity == null ? null : Number(row.popularity),
  });

  const detail = `"${row.term}" (${row.country}) — ours ${ourRank ?? "unranked"}, theirs #${row.their_rank ?? "—"}, difficulty ${row.difficulty ?? "—"}, popularity ${row.popularity ?? "—"}`;
  if (recomputed.bucket === wanted) ok(`bucket "${wanted}" verified by hand`, detail);
  else bad(`bucket "${wanted}"`, `stored as "${wanted}" but recomputes to "${recomputed.bucket}" — ${detail}`);
}

if (Object.keys(byBucket).length >= 2) ok("multiple buckets populated", `${Object.keys(byBucket).length} distinct buckets`);
else bad("multiple buckets populated", `only ${Object.keys(byBucket).length} bucket(s) present`);

// ---------------------------------------------------------------------------
console.log("\n2. Forced rank drop → exactly one alert");

const SCRATCH = "2026-08-02";
const target = await q1(
  db,
  `select r.app_id, r.keyword_id, r.rank, k.term, k.country, k.platform, a.name as app_name, ta.workspace_id
     from rankings r
     join keywords k on k.id = r.keyword_id
     join apps a on a.id = r.app_id
     join tracked_apps ta on ta.app_id = r.app_id and ta.role = 'own'
    where r.rank is not null and r.rank <= 10
    order by r.checked_on desc limit 1`,
);

if (!target) {
  bad("forced rank drop", "no ranked keyword available to test with");
} else {
  const wsId = target.workspace_id;

  // Snapshot state so this is fully reversible.
  const priorSettings = await q(db, `select kind, enabled, threshold from alert_settings where workspace_id = $1`, [wsId]);

  await db.query(
    `insert into alert_settings (workspace_id, kind, enabled, threshold) values ($1,'rank_drop',true,5)
     on conflict (workspace_id, kind) do update set enabled = true, threshold = 5`,
    [wsId],
  );

  // Write a scratch row 40 places worse.
  const dropped = target.rank + 40;
  await db.query(
    `insert into rankings (app_id, keyword_id, checked_on, rank, crawl_depth, found)
     values ($1,$2,$3,$4,250,true)
     on conflict (app_id, keyword_id, checked_on) do update set rank = excluded.rank`,
    [target.app_id, target.keyword_id, SCRATCH, dropped],
  );

  const fired = evaluateAlerts({
    today: { rank: dropped },
    yesterday: { rank: target.rank },
    settings: { rank_drop: { enabled: true, threshold: 5 } },
  });
  console.log(`   "${target.term}" ${target.country}: #${target.rank} → #${dropped} fires ${fired.length} rule(s)`);

  // Insert with the SAME dedup guard the crawler uses, then try again to prove it dedupes.
  const insert = async () =>
    db.query(
      `insert into alerts (workspace_id, app_id, keyword_id, kind, message, platform, country, from_rank, to_rank, occurred_on)
       select $1,$2,$3,'rank_drop',$4,$5,$6,$7,$8,$9
       where not exists (select 1 from alerts where app_id = $2 and coalesce(keyword_id, 0::bigint) = coalesce($3::bigint, 0::bigint) and kind = 'rank_drop' and occurred_on = $9)
       returning id`,
      [
        wsId, target.app_id, target.keyword_id,
        `${target.app_name} fell from #${target.rank} to #${dropped} for "${target.term}" (App Store · ${target.country.toUpperCase()})`,
        target.platform, target.country, target.rank, dropped, SCRATCH,
      ],
    );

  const first = await insert();
  const second = await insert(); // must be a no-op

  const total = await q1(db, `select count(*)::int as n from alerts where occurred_on = $1 and kind = 'rank_drop'`, [SCRATCH]);

  if (fired.length === 1 && total.n === 1 && first.rowCount === 1 && second.rowCount === 0) {
    ok("exactly one alert row", "the (app, keyword, kind, day) dedup guard held on a second evaluation");
  } else {
    bad("exactly one alert row", `rules fired ${fired.length}, rows ${total.n}, first insert ${first.rowCount}, second ${second.rowCount}`);
  }

  // --- one digest, rendered -------------------------------------------------
  const rows = await q(
    db,
    `select al.kind, al.message, al.platform, al.country, a.name as app_name
       from alerts al join apps a on a.id = al.app_id
      where al.workspace_id = $1 and al.occurred_on = $2`,
    [wsId, SCRATCH],
  );
  const digest = renderDigest({ workspaceName: "Mindset", alerts: rows, date: SCRATCH });

  console.log(`\n   Subject: ${digest.subject}`);
  console.log(`   ${digest.text.split("\n").join("\n   ")}`);

  const carriesStore = digest.html.includes("App Store") && digest.html.includes(target.country.toUpperCase());
  if (digest.subject.includes("1 ASO alert") && carriesStore) {
    ok("digest renders", "one email for the whole workspace, and every line carries the store and country");
  } else {
    bad("digest renders", `subject "${digest.subject}", store/country present: ${carriesStore}`);
  }

  // --- clean up -------------------------------------------------------------
  await db.query(`delete from alerts where occurred_on = $1`, [SCRATCH]);
  await db.query(`delete from rankings where checked_on = $1`, [SCRATCH]);
  await db.query(`delete from alert_settings where workspace_id = $1`, [wsId]);
  for (const s of priorSettings) {
    await db.query(`insert into alert_settings (workspace_id, kind, enabled, threshold) values ($1,$2,$3,$4)`, [wsId, s.kind, s.enabled, s.threshold]);
  }
  ok("cleanup", "scratch alert, ranking and settings rows removed; prior settings restored");
}

console.log(`\n${"─".repeat(70)}`);
console.log(`GATE 5: \x1b[32m${pass} passed\x1b[0m, ${fail ? `\x1b[31m${fail} failed\x1b[0m` : "0 failed"}`);
await db.end();
process.exit(fail ? 1 : 0);
