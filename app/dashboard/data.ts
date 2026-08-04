/**
 * Dashboard data assembly. Kept out of page.tsx so the page stays readable and the
 * plain-English "reason" strings live next to the thresholds that generate them.
 */
import { q, q1 } from "@/lib/db";
import { getDailyMetrics, getLatestMetrics, getStaleness, listKeywords, type TrackedApp } from "@/lib/queries";

export async function getActiveAppData(app: TrackedApp) {
  const [series, latest, staleness, keywords] = await Promise.all([
    getDailyMetrics(app.app_id, 30),
    getLatestMetrics(app.app_id),
    getStaleness(app.app_id),
    listKeywords(app.tracked_app_id, app.app_id),
  ]);

  const previous = series.length > 1 ? series[series.length - 2] : null;
  const visibilityDelta =
    latest?.visibility != null && previous?.visibility != null
      ? Math.round(Number(latest.visibility) - Number(previous.visibility))
      : null;
  const rankedDelta =
    latest?.ranked_count != null && previous?.ranked_count != null
      ? Number(latest.ranked_count) - Number(previous.ranked_count)
      : null;

  const counts = await q1<{ discovered: number; competitors: number; reviews: number }>(
    `select
       (select count(*)::int from discovered_keywords where tracked_app_id = $1 and not dismissed) as discovered,
       (select count(*)::int from tracked_apps where competitor_of = $1 and is_active)             as competitors,
       (select count(*)::int from reviews where app_id = $2)                                        as reviews`,
    [app.tracked_app_id, app.app_id],
  );

  // 30-day rank distribution with the switches the panel offers: keyword-count vs
  // popularity-weighted stacks, everything vs starred targets only.
  const distribution = await q<Record<string, unknown>>(
    `select r.checked_on::text as metric_on,
            count(*) filter (where r.rank <= 3)::int                                            as c1,
            count(*) filter (where r.rank between 4 and 10)::int                                as c2,
            count(*) filter (where r.rank between 11 and 30)::int                               as c3,
            count(*) filter (where r.rank between 31 and 100)::int                              as c4,
            count(*) filter (where r.rank > 100)::int                                           as c5,
            coalesce(sum(coalesce(k.popularity_estimate, k.popularity, 0)) filter (where r.rank <= 3), 0)::int              as w1,
            coalesce(sum(coalesce(k.popularity_estimate, k.popularity, 0)) filter (where r.rank between 4 and 10), 0)::int  as w2,
            coalesce(sum(coalesce(k.popularity_estimate, k.popularity, 0)) filter (where r.rank between 11 and 30), 0)::int as w3,
            coalesce(sum(coalesce(k.popularity_estimate, k.popularity, 0)) filter (where r.rank between 31 and 100), 0)::int as w4,
            coalesce(sum(coalesce(k.popularity_estimate, k.popularity, 0)) filter (where r.rank > 100), 0)::int             as w5,
            count(*) filter (where r.rank <= 3 and tk.starred)::int                             as s1,
            count(*) filter (where r.rank between 4 and 10 and tk.starred)::int                 as s2,
            count(*) filter (where r.rank between 11 and 30 and tk.starred)::int                as s3,
            count(*) filter (where r.rank between 31 and 100 and tk.starred)::int               as s4,
            count(*) filter (where r.rank > 100 and tk.starred)::int                            as s5
       from rankings r
       join keywords k on k.id = r.keyword_id
       join tracked_keywords tk on tk.keyword_id = r.keyword_id and tk.tracked_app_id = $2
      where r.app_id = $1 and r.rank is not null
        and r.checked_on > current_date - interval '30 days'
      group by r.checked_on
      order by r.checked_on`,
    [app.app_id, app.tracked_app_id],
  );

  const bucketRows = await q<{ bucket: string; n: number }>(
    `select bucket, count(*)::int as n from competitive_positions where tracked_app_id = $1 group by bucket`,
    [app.tracked_app_id],
  );
  const buckets = { gap: 0, winnable: 0, threat: 0, lead: 0, ...Object.fromEntries(bucketRows.map((b) => [b.bucket, b.n])) };

  const biggestGap = await q1<{ term: string; their_rank: number; competitor_name: string }>(
    `select k.term, cp.their_rank, a.name as competitor_name
       from competitive_positions cp
       join keywords k on k.id = cp.keyword_id
       left join apps a on a.id = cp.best_competitor_app_id
      where cp.tracked_app_id = $1 and cp.bucket in ('gap','winnable')
      order by cp.opportunity desc nulls last limit 1`,
    [app.tracked_app_id],
  );

  const ranked = keywords.filter((k) => k.rank != null);

  return {
    series,
    distribution,
    latest,
    staleness,
    visibilityDelta,
    rankedDelta,
    keywordCount: keywords.length,
    brandedCount: keywords.filter((k) => k.is_branded).length,
    discoveredCount: counts?.discovered ?? 0,
    competitorCount: counts?.competitors ?? 0,
    reviewCount: counts?.reviews ?? 0,
    buckets,
    biggestGap,
    topKeywords: keywords.slice(0, 6),
    featInputs: keywords.map((k) => ({ term: k.term, rank: k.rank, best_rank: k.best_rank, delta_30d: k.delta_30d })),
    opportunities: opportunitiesFrom(keywords),
    improvements: [...keywords].filter((k) => (k.delta_7d ?? 0) > 0).sort((a, b) => (b.delta_7d ?? 0) - (a.delta_7d ?? 0)).slice(0, 5),
    drops: [...keywords].filter((k) => (k.delta_7d ?? 0) < 0).sort((a, b) => (a.delta_7d ?? 0) - (b.delta_7d ?? 0)).slice(0, 5),
    rankedCount: ranked.length,
  };
}

/**
 * "Where to push next", each row carrying a plain-English reason.
 *
 * The templated reasons are the point: "1 spot from page 1" tells someone what to do,
 * "opportunity 74" does not.
 */
function opportunitiesFrom(keywords: Awaited<ReturnType<typeof listKeywords>>) {
  const scored = keywords
    .map((k) => {
      const rank = k.rank;
      let reason: string | null = null;

      if (rank != null && rank > 10 && rank <= 11) reason = "1 spot from page 1";
      else if (rank != null && rank > 10 && rank <= 20) reason = `${rank - 10} spots from page 1`;
      else if (rank != null && rank > 3 && rank <= 10) reason = "within reach of top 3";
      else if (rank != null && rank > 20 && rank <= 40) reason = `${rank - 10} spots from page 1`;
      else if (rank == null && (k.difficulty ?? 100) <= 40 && (k.popularity_estimate ?? k.popularity ?? 0) >= 20)
        reason = "unranked, but low difficulty and real demand";

      return { ...k, reason };
    })
    .filter((k) => k.reason);

  // Closest to a payoff first: a smaller rank means a shorter climb.
  return scored.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999)).slice(0, 6);
}
