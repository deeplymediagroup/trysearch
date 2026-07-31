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
