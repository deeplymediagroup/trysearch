/**
 * Every read the dashboard performs. Server Components call these directly — there is no
 * /api layer for our own UI, because that would be a second data model to keep in sync.
 *
 * Performance rules (06 §6): read `ranking_current` and `app_daily_metrics`, never aggregate
 * raw `rankings` at request time, and paginate server-side.
 */
import { q, q1 } from "./db";

export type TrackedApp = {
  tracked_app_id: string;
  app_id: string;
  workspace_id: string;
  platform: "ios" | "android";
  store_id: string;
  name: string;
  developer_name: string | null;
  icon_url: string | null;
  role: "own" | "competitor";
  device: string | null;
  version: string | null;
  rating_average: number | null;
  rating_count: number | null;
  keyword_count: number;
};

/** Every app the workspace tracks, own apps first. Drives the app switcher. */
export async function listTrackedApps(): Promise<TrackedApp[]> {
  return q<TrackedApp>(
    `select ta.id as tracked_app_id, ta.app_id, ta.workspace_id, ta.role, ta.device,
            a.platform, a.store_id, a.name, a.developer_name, a.icon_url, a.version,
            s.rating_average, s.rating_count,
            (select count(*)::int from tracked_keywords tk where tk.tracked_app_id = ta.id) as keyword_count
       from tracked_apps ta
       join apps a on a.id = ta.app_id
       left join lateral (
         select rating_average, rating_count from app_snapshots
          where app_id = a.id order by captured_on desc limit 1
       ) s on true
      where ta.is_active
      order by (ta.role = 'own') desc, a.name`,
  );
}

export async function getTrackedApp(trackedAppId?: string): Promise<TrackedApp | null> {
  const apps = await listTrackedApps();
  if (!apps.length) return null;
  if (trackedAppId) return apps.find((a) => a.tracked_app_id === trackedAppId) ?? apps[0];
  return apps.find((a) => a.role === "own") ?? apps[0];
}

export type KeywordRow = {
  tracked_keyword_id: string;
  keyword_id: string;
  term: string;
  platform: "ios" | "android";
  country: string;
  source: string;
  starred: boolean;
  note: string | null;
  is_branded: boolean;
  popularity: number | null;
  popularity_source: string | null;
  popularity_estimate: number | null;
  difficulty: number | null;
  difficulty_parts: Record<string, unknown> | null;
  serp_outlier: boolean;
  est_downloads_rank1: number | null;
  metrics_updated_at: string | null;
  gap: number | null;
  rank: number | null;
  found: boolean | null;
  last_known_rank: number | null;
  delta_1d: number | null;
  delta_7d: number | null;
  delta_30d: number | null;
  avg_7d: number | null;
  avg_30d: number | null;
  best_rank: number | null;
  checked_at: string | null;
  crawl_depth: number | null;
  opportunity: number | null;
  top_apps: { name: string; icon_url: string | null; position: number }[];
  trend: (number | null)[];
};

/**
 * The /keywords and /rankings table, in ONE read. The v_tracked_keyword_rows view exists
 * precisely so this page is a single query rather than a window function over all history.
 */
export async function listKeywords(trackedAppId: string, appId: string): Promise<KeywordRow[]> {
  return q<KeywordRow>(
    `select v.*,
            r.crawl_depth,
            coalesce(dk.opportunity, null) as opportunity,
            -- the Top Results icon strip, from the most recent SERP capture
            coalesce((
              select json_agg(json_build_object('name', a2.name, 'icon_url', a2.icon_url, 'position', sr.position)
                              order by sr.position)
                from serp_results sr
                join apps a2 on a2.id = sr.app_id
               where sr.keyword_id = v.keyword_id
                 and sr.captured_on = (select max(captured_on) from serp_results where keyword_id = v.keyword_id)
                 and sr.position <= 6
            ), '[]'::json) as top_apps,
            -- 14-day rank trend for the sparkline; gaps stay gaps
            coalesce((
              select json_agg(x.rank order by x.checked_on)
                from (select checked_on, rank from rankings
                       where app_id = $2 and keyword_id = v.keyword_id
                       order by checked_on desc limit 14) x
            ), '[]'::json) as trend
       from v_tracked_keyword_rows v
       left join lateral (
         select crawl_depth from rankings
          where keyword_id = v.keyword_id and app_id = $2
          order by checked_on desc limit 1
       ) r on true
       left join discovered_keywords dk on dk.keyword_id = v.keyword_id and dk.tracked_app_id = v.tracked_app_id
      where v.tracked_app_id = $1
      order by v.term`,
    [trackedAppId, appId],
  );
}

export type DiscoveredRow = {
  id: string;
  keyword_id: string;
  term: string;
  platform: string;
  country: string;
  source: string;
  relevance: number | null;
  opportunity: number | null;
  last_checked_at: string | null;
  popularity: number | null;
  popularity_estimate: number | null;
  difficulty: number | null;
  rank: number | null;
  found: boolean | null;
  last_known_rank: number | null;
  crawl_depth: number | null;
};

export async function listDiscovered(trackedAppId: string, appId: string): Promise<DiscoveredRow[]> {
  return q<DiscoveredRow>(
    `select d.id, d.keyword_id, d.source, d.relevance, d.opportunity, d.last_checked_at,
            k.term, k.platform, k.country, k.popularity, k.popularity_estimate, k.difficulty,
            rc.rank, rc.found, rc.last_known_rank, null::int as crawl_depth
       from discovered_keywords d
       join keywords k on k.id = d.keyword_id
       left join ranking_current rc on rc.keyword_id = k.id and rc.app_id = $2
      where d.tracked_app_id = $1 and not d.dismissed
      order by d.opportunity desc nulls last, k.term
      limit 500`,
    [trackedAppId, appId],
  );
}

/** Dashboard KPI strip + charts, read from the rollup tables. */
export async function getDailyMetrics(appId: string, days = 30) {
  return q(
    `select metric_on, visibility, share_of_voice, ranked_count, top3_count, top10_count,
            bracket_11_30, bracket_31_100, bracket_100_plus, best_rank, best_rank_keyword_id,
            movers_up, movers_down
       from app_daily_metrics
      where app_id = $1 and metric_on > current_date - ($2 || ' days')::interval
      order by metric_on`,
    [appId, String(days)],
  );
}

export async function getLatestMetrics(appId: string) {
  return q1(
    `select m.*, k.term as best_rank_term
       from app_daily_metrics m
       left join keywords k on k.id = m.best_rank_keyword_id
      where m.app_id = $1 order by m.metric_on desc limit 1`,
    [appId],
  );
}

/** When did the crawl last touch this app? Drives the required staleness note. */
export async function getStaleness(appId: string): Promise<Date | null> {
  const row = await q1<{ at: Date | null }>(
    `select max(checked_at) as at from rankings r
      where r.app_id = $1`,
    [appId],
  );
  return row?.at ?? null;
}

export async function getCompetitors(trackedAppId: string) {
  return q(
    `select c.id as tracked_app_id, a.id as app_id, a.name, a.developer_name, a.icon_url,
            a.version, a.platform, a.store_id,
            s.rating_average, s.rating_count, s.install_count, s.captured_on,
            a.version_released_at,
            re.display as revenue_display, re.confidence as revenue_confidence, re.model as revenue_model
       from tracked_apps c
       join apps a on a.id = c.app_id
       left join lateral (
         select rating_average, rating_count, install_count, captured_on from app_snapshots
          where app_id = a.id order by captured_on desc limit 1
       ) s on true
       left join lateral (
         select display, confidence, model from revenue_estimates
          where app_id = a.id order by estimated_on desc limit 1
       ) re on true
      where c.competitor_of = $1 and c.is_active
      order by a.name`,
    [trackedAppId],
  );
}

export async function getCompetitivePositions(trackedAppId: string) {
  return q(
    `select cp.bucket, cp.their_rank, cp.our_rank, cp.opportunity,
            k.term, k.country, k.platform, k.popularity, k.popularity_estimate, k.difficulty,
            a.name as competitor_name, a.icon_url as competitor_icon
       from competitive_positions cp
       join keywords k on k.id = cp.keyword_id
       left join apps a on a.id = cp.best_competitor_app_id
      where cp.tracked_app_id = $1
      order by cp.opportunity desc nulls last`,
    [trackedAppId],
  );
}

export async function getActivity(workspaceId: string, scope: "all" | "own" | "competitor" = "all", limit = 100) {
  const roleFilter = scope === "all" ? "" : `and ta.role = '${scope === "own" ? "own" : "competitor"}'`;
  return q(
    `select e.id, e.kind, e.field, e.old_value, e.new_value, e.release_notes, e.occurred_on, e.country,
            a.name as app_name, a.icon_url, a.platform, ta.role
       from activity_events e
       join apps a on a.id = e.app_id
       join tracked_apps ta on ta.app_id = a.id and ta.is_active and ta.workspace_id = $1
      where true ${roleFilter}
      order by e.occurred_on desc, e.id desc
      limit $2`,
    [workspaceId, limit],
  );
}

export async function getAlerts(workspaceId: string, limit = 60) {
  return q(
    `select al.id, al.kind, al.message, al.platform, al.country, al.from_rank, al.to_rank,
            al.occurred_on, al.read_at, a.name as app_name
       from alerts al
       join apps a on a.id = al.app_id
      where al.workspace_id = $1
      order by al.occurred_on desc, al.id desc
      limit $2`,
    [workspaceId, limit],
  );
}

export async function getAlertSettings(workspaceId: string) {
  const rows = await q<{ kind: string; enabled: boolean; threshold: number | null }>(
    `select kind, enabled, threshold from alert_settings where workspace_id = $1`,
    [workspaceId],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r]));
}

export async function getReviews(appId: string, { minRating = 1, maxRating = 5, sort = "recent", limit = 100 } = {}) {
  const order = sort === "helpful" ? "helpful_count desc nulls last, reviewed_at desc" : "reviewed_at desc";
  return q(
    `select id, country, rating, title, body, author, app_version, helpful_count, reviewed_at
       from reviews
      where app_id = $1 and rating between $2 and $3
      order by ${order}
      limit $4`,
    [appId, minRating, maxRating, limit],
  );
}

/** Rank history for the chart. Never interpolates: missing days come back as gaps. */
export async function getRankHistory(appId: string, keywordIds: string[], days = 30) {
  if (!keywordIds.length) return [];
  return q(
    `select r.keyword_id, k.term, k.country, r.checked_on, r.rank
       from rankings r
       join keywords k on k.id = r.keyword_id
      where r.app_id = $1 and r.keyword_id = any($2::bigint[])
        and r.checked_on > current_date - ($3 || ' days')::interval
      order by r.checked_on`,
    [appId, keywordIds, String(days)],
  );
}

export async function getAnnotations(trackedAppId: string, days = 30) {
  return q(
    `select id, occurred_on, label, auto from annotations
      where tracked_app_id = $1 and occurred_on > current_date - ($2 || ' days')::interval
      order by occurred_on`,
    [trackedAppId, String(days)],
  );
}

export async function getListings(trackedAppId: string) {
  return q(
    `select id, locale, country, status, is_primary, app_name, subtitle, keywords_field,
            promotional_text, description, release_notes, source, synced_at
       from listings where tracked_app_id = $1
      order by is_primary desc, locale`,
    [trackedAppId],
  );
}

/** The latest store snapshot, used as the fallback "live listing" when ASC is not connected. */
export async function getLatestSnapshot(appId: string, country = "us") {
  return q1(
    `select * from app_snapshots where app_id = $1 and country = $2
      order by captured_on desc limit 1`,
    [appId, country],
  );
}

export async function getSerpResults(keywordId: string) {
  return q(
    `select sr.position, sr.rating_count, sr.rating_average, sr.title_match,
            a.name, a.icon_url, a.store_id, a.developer_name
       from serp_results sr
       join apps a on a.id = sr.app_id
      where sr.keyword_id = $1
        and sr.captured_on = (select max(captured_on) from serp_results where keyword_id = $1)
      order by sr.position`,
    [keywordId],
  );
}

export async function getTargetKeywords(trackedAppId: string, locale: string) {
  return q(
    `select t.slot, t.keyword_id, k.term, k.country
       from target_keywords t join keywords k on k.id = t.keyword_id
      where t.tracked_app_id = $1 and t.locale = $2
      order by t.slot`,
    [trackedAppId, locale],
  );
}

/** Countries this app is actually tracked in — a rank without a storefront is meaningless. */
export async function getCountries(trackedAppId: string): Promise<string[]> {
  const rows = await q<{ country: string }>(
    `select distinct k.country from tracked_keywords tk
       join keywords k on k.id = tk.keyword_id
      where tk.tracked_app_id = $1 order by k.country`,
    [trackedAppId],
  );
  return rows.map((r) => r.country);
}
