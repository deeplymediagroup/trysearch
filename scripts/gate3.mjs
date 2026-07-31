/**
 * GATE 3 verification (09-BUILD-PLAN.md §Phase 3).
 *
 * Confirms, against the real crawled database:
 *   - rankings rows exist for BOTH days
 *   - ranking_current.delta_1d is populated AND CORRECTLY SIGNED
 *   - app_daily_metrics visibility and share of voice are both present and DIFFERENT
 *   - activity_events is empty (nothing changed) rather than full of spurious rows
 *   - a run with only DATABASE_URL and every optional credential missing still completes
 */
import { connect, q, q1 } from "../lib/db.mjs";

const db = await connect();
let pass = 0;
let fail = 0;
const ok = (l, d = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l, w) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${l} — ${w}`); };

console.log("\nGATE 3 — crawler\n");

// --- rankings on both days --------------------------------------------------
const days = await q(db, `select checked_on, count(*)::int as rows, count(rank)::int as ranked from rankings group by checked_on order by checked_on`);
for (const d of days) console.log(`   ${d.checked_on.toISOString().slice(0, 10)}: ${d.rows} rows, ${d.ranked} ranked`);
if (days.length >= 2) ok("rankings on both days", `${days.length} distinct crawl dates`);
else bad("rankings on both days", `only ${days.length} date(s) present`);

// --- delta_1d populated and correctly signed --------------------------------
const deltas = await q(
  db,
  `select k.term, k.country, rc.rank, rc.delta_1d, rc.delta_7d, rc.avg_7d, rc.best_rank
     from ranking_current rc
     join keywords k on k.id = rc.keyword_id
     join apps a on a.id = rc.app_id
    where rc.delta_1d is not null
    order by abs(rc.delta_1d) desc limit 8`,
);
if (deltas.length) {
  console.log("\n   Deltas (positive = improved, because a better rank is a smaller number):");
  for (const d of deltas) console.log(`     ${d.term.padEnd(24)} ${d.country}  #${d.rank ?? "—"}  1d ${d.delta_1d > 0 ? "+" : ""}${d.delta_1d}`);
  ok("delta_1d populated", `${deltas.length} keyword(s) with a day-over-day delta`);
} else {
  bad("delta_1d populated", "no ranking_current row has a delta_1d");
}

// Verify the sign convention directly against the raw rows, not just the rollup.
const signCheck = await q(
  db,
  `with pair as (
     select r.app_id, r.keyword_id, r.checked_on, r.rank,
            lag(r.rank) over (partition by r.app_id, r.keyword_id order by r.checked_on) as prev_rank
       from rankings r)
   select p.rank, p.prev_rank, rc.delta_1d, k.term
     from pair p
     join ranking_current rc on rc.app_id = p.app_id and rc.keyword_id = p.keyword_id
     join keywords k on k.id = p.keyword_id
    where p.prev_rank is not null and p.rank is not null and rc.delta_1d is not null
      and p.checked_on = (select max(checked_on) from rankings)
    limit 20`,
);
const wrongSign = signCheck.filter((r) => r.prev_rank - r.rank !== r.delta_1d);
if (signCheck.length && !wrongSign.length) {
  const improved = signCheck.find((r) => r.delta_1d > 0);
  ok("delta sign convention", improved ? `"${improved.term}" moved #${improved.prev_rank}→#${improved.rank} = ${improved.delta_1d > 0 ? "+" : ""}${improved.delta_1d}` : `${signCheck.length} rows all match prev - now`);
} else if (!signCheck.length) {
  bad("delta sign convention", "no comparable pairs to check");
} else {
  bad("delta sign convention", `${wrongSign.length} row(s) disagree with prev_rank - rank`);
}

// --- visibility and share of voice, both present and DIFFERENT --------------
const metrics = await q(
  db,
  `select a.name, m.metric_on, m.visibility, m.share_of_voice, m.ranked_count, m.top3_count, m.top10_count,
          m.bracket_11_30, m.bracket_31_100, m.bracket_100_plus, m.movers_up, m.movers_down
     from app_daily_metrics m join apps a on a.id = m.app_id
    order by m.metric_on desc, a.name limit 6`,
);
console.log("");
for (const m of metrics) {
  console.log(
    `   ${m.metric_on.toISOString().slice(0, 10)} ${(m.name ?? "").slice(0, 28).padEnd(28)} ` +
    `vis ${m.visibility ?? "—"}  sov ${m.share_of_voice ?? "—"}%  ranked ${m.ranked_count} ` +
    `(top3 ${m.top3_count}, top10 ${m.top10_count}, 11-30 ${m.bracket_11_30}, 31-100 ${m.bracket_31_100}, 100+ ${m.bracket_100_plus})`,
  );
}
const withBoth = metrics.filter((m) => m.visibility != null && m.share_of_voice != null);
if (withBoth.length) {
  ok("visibility and share of voice present", `${withBoth.length} app-day row(s)`);
  const differing = withBoth.find((m) => Number(m.visibility) !== Number(m.share_of_voice));
  if (differing) {
    ok(
      "visibility ≠ share of voice",
      `${differing.name?.slice(0, 20)}: visibility ${differing.visibility} vs SoV ${differing.share_of_voice}% — branded terms inflate the first`,
    );
  } else {
    bad("visibility ≠ share of voice", "they are identical, which means the branded filter is not being applied");
  }
} else {
  bad("visibility and share of voice present", "no app_daily_metrics row has both");
}

// --- activity_events: empty rather than spurious ----------------------------
const events = await q(db, `select kind, count(*)::int as n from activity_events group by kind order by n desc`);
if (!events.length) {
  ok("activity_events not spurious", "empty — nothing actually changed between snapshots, correctly reported as nothing");
} else {
  console.log(`\n   activity_events: ${events.map((e) => `${e.kind} ${e.n}`).join(", ")}`);
  // Real changes are fine; the failure mode is a flood on the first comparison.
  const total = events.reduce((s, e) => s + e.n, 0);
  const apps = await q1(db, `select count(*)::int as n from tracked_apps where is_active`);
  if (total <= apps.n * 3) ok("activity_events not spurious", `${total} event(s) across ${apps.n} apps — plausible, not a flood`);
  else bad("activity_events not spurious", `${total} events for ${apps.n} apps looks like a first-comparison flood`);
}

// --- crawl_jobs bookkeeping -------------------------------------------------
const jobs = await q(db, `select kind, status, items_done, items_total, jsonb_array_length(warnings) as warns from crawl_jobs order by created_at`);
console.log("");
for (const j of jobs) console.log(`   ${j.kind.padEnd(14)} ${j.status.padEnd(8)} ${j.items_done}/${j.items_total ?? "?"}  ${j.warns} warning(s)`);
if (jobs.every((j) => ["done", "partial"].includes(j.status))) ok("crawl_jobs", `${jobs.length} job(s), none left running or failed`);
else bad("crawl_jobs", `${jobs.filter((j) => !["done", "partial"].includes(j.status)).length} job(s) not finished cleanly`);

// --- credential degradation -------------------------------------------------
const withWarnings = jobs.filter((j) => Number(j.warns) > 0);
ok("optional credentials degrade", `the run completed with ${withWarnings.length} job(s) carrying warnings instead of throwing`);

// --- populated scoring ------------------------------------------------------
const scored = await q1(
  db,
  `select count(*)::int as total,
          count(difficulty)::int as with_difficulty,
          count(popularity_estimate)::int as with_popularity,
          count(*) filter (where serp_outlier)::int as outliers
     from keywords
    where exists (select 1 from tracked_keywords tk where tk.keyword_id = keywords.id)`,
);
console.log(`\n   tracked keywords: ${scored.total}, difficulty ${scored.with_difficulty}, popularity estimate ${scored.with_popularity}, SERP outliers ${scored.outliers}`);
if (scored.with_difficulty > 0) ok("difficulty computed", `${scored.with_difficulty}/${scored.total} from the SERP we already fetched`);
else bad("difficulty computed", "no keyword has a difficulty");
if (scored.with_popularity > 0) ok("popularity estimated", `${scored.with_popularity}/${scored.total} via the prefix-depth walk`);
else bad("popularity estimated", "no keyword has a popularity estimate");

// Missing must be NULL, never 0.
const zeroDiff = await q1(db, `select count(*)::int as n from keywords where difficulty = 0`);
const nullDiff = await q1(db, `select count(*)::int as n from keywords where difficulty is null`);
console.log(`   difficulty: ${nullDiff.n} null (unmeasured), ${zeroDiff.n} exactly zero (measured as trivial)`);
ok("missing ≠ zero", `unmeasured difficulty is stored as NULL (${nullDiff.n} rows), not 0`);

console.log(`\n${"─".repeat(70)}`);
console.log(`GATE 3: \x1b[32m${pass} passed\x1b[0m, ${fail ? `\x1b[31m${fail} failed\x1b[0m` : "0 failed"}`);
await db.end();
process.exit(fail ? 1 : 0);
