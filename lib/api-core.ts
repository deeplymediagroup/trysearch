/**
 * One operation registry that powers BOTH the REST API (/api/v1) and the MCP server (/mcp).
 * 05-API-ROUTES.md §2-3. Each op declares a JSON Schema (used verbatim as the MCP tool
 * inputSchema) and a run() that returns plain JSON.
 *
 * snake_case everywhere, per the spec's naming-discipline note.
 */
import { q, q1, currentWorkspace } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import {
  appleLookup,
  appleSearch,
  appleAutocomplete,
  appleReviews,
  appleChartsRSS,
  suggestDepth,
} from "@/lib/stores/apple.mjs";
import { playAppDetail, playSearchRanked, playSuggest, playCategoryRanking, extractListingKeywords } from "@/lib/stores/play.mjs";
import { asoScore, popularityProxy } from "@/lib/scoring/scores.mjs";

let sinkReady = false;
function withSink() {
  if (sinkReady) return;
  setFetchSink({ query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) });
  sinkReady = true;
}

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new ApiError("internal_error", "No workspace — run migrations.", 500);
  return ws.id;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const STORE = { type: "string", enum: ["ios", "android"], description: "App store" } as const;
const COUNTRY = { type: "string", description: "Two-letter storefront, default us" } as const;
const CURSOR = { type: "string", description: "Opaque cursor from a previous response's pagination.next_cursor" } as const;
const LIMIT = { type: "integer", description: "Rows per page, 1-200 (default 50)" } as const;

/**
 * Cursor pagination — 05-API-ROUTES.md §2.1.
 *
 * Keyset, never OFFSET. The nightly crawl inserts and deletes under these tables all night;
 * an offset page 2 taken after an insert silently repeats a row, and after a delete silently
 * skips one. A cursor on a stable unique column can do neither. Every list op fetches n+1
 * rows to learn whether another page exists without a second COUNT query.
 */
function pageArgs({ cursor, limit }: { cursor?: string; limit?: number }, dflt = 50) {
  return { n: Math.min(Math.max(Number(limit) || dflt, 1), 200), after: cursor ? String(cursor) : null };
}

function paged<T extends Record<string, any>>(rows: T[], n: number, idField: string) {
  const has_more = rows.length > n;
  const items = has_more ? rows.slice(0, n) : rows;
  const last = items[items.length - 1];
  return {
    items,
    pagination: { next_cursor: has_more && last ? String(last[idField]) : null, has_more },
  };
}

/**
 * THE gate for every op, whichever surface called it — REST, MCP, anything later.
 *
 * Scope lives here rather than in the two route handlers on purpose: a check duplicated per
 * handler is a check someone forgets to add to the third one. `write: true` on the op is the
 * single declaration, and this is the single place it is honoured.
 *
 * What `write` protects is WORKSPACE data — tracked apps, tracked keywords, competitors, alert
 * rules, annotations. It is not a promise that a read op touches no rows at all: read ops may
 * fill the shared public-data caches (`apps`, `keywords`, `revenue_estimates`, `upstream_cache`)
 * as a side effect of measuring something, exactly as the crawler does. Those rows are global
 * measurements, not this workspace's configuration, and a read key losing that ability would
 * make the research tools useless.
 */
export async function runOp(name: string, params: unknown, identity: { scope: "read" | "write" }) {
  const op = OPS[name];
  if (!op) throw new ApiError("not_found", `No such operation: ${name}`, 404);
  if (op.write && identity.scope !== "write") {
    throw new ApiError("forbidden", `"${name}" modifies workspace data and needs a write-scoped key. This key is read-only.`, 403);
  }
  return op.run(params ?? {});
}

async function lookupApp(store: string, id: string, country: string) {
  withSink();
  if (store === "ios") {
    const [app] = await appleLookup([id], country);
    if (!app) throw new ApiError("not_found", `No iOS app with id ${id} in ${country}.`, 404);
    return app;
  }
  const app = await playAppDetail(id, country);
  if (!app) throw new ApiError("not_found", `No Android app with package ${id} in ${country}.`, 404);
  return app;
}

/** Resolve the workspace's own tracked app when the caller doesn't name one. */
async function resolveTrackedApp(ws: string, trackedAppId?: string) {
  const row = trackedAppId
    ? await q1<any>(
        `select ta.id, ta.app_id, a.name, a.platform from tracked_apps ta join apps a on a.id = ta.app_id
          where ta.id = $1 and ta.workspace_id = $2 and ta.is_active`,
        [trackedAppId, ws],
      )
    : await q1<any>(
        `select ta.id, ta.app_id, a.name, a.platform from tracked_apps ta join apps a on a.id = ta.app_id
          where ta.workspace_id = $1 and ta.role = 'own' and ta.is_active order by ta.added_at limit 1`,
        [ws],
      );
  if (!row) throw new ApiError("not_found", "No tracked app found for this workspace.", 404);
  return row;
}

type Op = {
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  write?: boolean;
  run: (params: any) => Promise<any>;
};

export const OPS: Record<string, Op> = {
  // ── Stateless research ────────────────────────────────────────────────────
  app_search: {
    description: "Search a store for apps by name; returns app records in store ranking order.",
    schema: {
      type: "object",
      properties: { q: { type: "string" }, store: STORE, country: COUNTRY, num: { type: "integer", description: "1-50, default 10" } },
      required: ["q", "store"],
    },
    async run({ q: term, store, country = "us", num = 10 }) {
      withSink();
      const n = Math.min(Math.max(Number(num) || 10, 1), 50);
      if (store === "ios") return (await appleSearch(term, country, n)).slice(0, n);
      const ranked = (await playSearchRanked(term, country)).slice(0, n);
      return ranked;
    },
  },

  app_lookup: {
    description: "Full public app record by store id (iOS numeric id or Android package name).",
    schema: { type: "object", properties: { store: STORE, id: { type: "string" }, country: COUNTRY }, required: ["store", "id"] },
    async run({ store, id, country = "us" }) {
      return lookupApp(store, id, country);
    },
  },

  app_aso_score: {
    description: "Audit any app's listing: 0-100 ASO score with nine named checks and a fix tip for each.",
    schema: { type: "object", properties: { store: STORE, id: { type: "string" }, country: COUNTRY }, required: ["store", "id"] },
    async run({ store, id, country = "us" }) {
      const app: any = await lookupApp(store, id, country);
      return {
        app: { store_id: app.store_id, name: app.name },
        ...asoScore({
          name: app.name ?? "",
          description: app.description ?? "",
          screenshot_urls: app.screenshot_urls ?? [],
          rating_average: app.rating_average,
          rating_count: app.rating_count,
          version_released_at: app.version_released_at,
          release_notes: app.release_notes ?? "",
        }),
      };
    },
  },

  app_extract_keywords: {
    description: "Extract the keywords an app's public listing text is targeting, scored 0-1.",
    schema: {
      type: "object",
      properties: { store: STORE, id: { type: "string" }, country: COUNTRY, max: { type: "integer", description: "1-50, default 20" } },
      required: ["store", "id"],
    },
    async run({ store, id, country = "us", max = 20 }) {
      const app: any = await lookupApp(store, id, country);
      const keywords = extractListingKeywords(app, { max: Math.min(Math.max(Number(max) || 20, 1), 50) });
      return { app: { store_id: app.store_id, name: app.name }, keywords };
    },
  },

  app_reviews: {
    description: "Recent public customer reviews for an app (iOS only — Play exposes no free review feed).",
    schema: {
      type: "object",
      properties: { store: STORE, id: { type: "string" }, country: COUNTRY, sort: { type: "string", enum: ["mostrecent", "mosthelpful"] }, limit: { type: "integer" } },
      required: ["store", "id"],
    },
    async run({ store, id, country = "us", sort = "mostrecent", limit = 50 }) {
      if (store !== "ios") throw new ApiError("bad_request", "Reviews are iOS-only; Google exposes no free review feed.");
      withSink();
      const page = await appleReviews(id, country, 1, sort);
      return (page?.reviews ?? []).slice(0, Math.min(Number(limit) || 50, 200));
    },
  },

  app_revenue: {
    description:
      "Estimated monthly revenue, monetization model and confidence for one app or many. Pass `id` for one, or `ids` for up to 25 — a bulk call returns one result per app and never fails the whole batch. Computes on demand for an app we have never seen.",
    schema: {
      type: "object",
      properties: {
        store: STORE,
        id: { type: "string", description: "One store id" },
        ids: { type: "array", items: { type: "string" }, description: "Up to 25 store ids" },
      },
      required: ["store"],
    },
    async run({ store, id, ids }) {
      const list: string[] = (ids ?? (id ? [id] : [])).slice(0, 25).map(String);
      if (!list.length) throw new ApiError("bad_request", "Pass id or ids.");

      const out = [];
      for (const storeId of list) {
        try {
          const row = await q1(
            `select a.name, a.store_id, a.platform, re.model, re.confidence, re.monthly_usd_low,
                    re.monthly_usd_high, re.display, re.factors, re.estimated_on
               from apps a join revenue_estimates re on re.app_id = a.id
              where a.store_id = $1 and a.platform = $2
              order by re.estimated_on desc limit 1`,
            [storeId, store],
          );
          if (row) {
            out.push({ ...row, source: "crawl" });
            continue;
          }
          // Nothing stored: compute it now rather than 404. This op used to always 404 for any
          // app outside the crawl set, which made it useless to an agent asking about a
          // competitor it had just found.
          const { lookupRevenue } = await import("@/app/actions/revenue");
          const live = await lookupRevenue(storeId);
          if (live.error || !live.result) {
            out.push({ store_id: storeId, error: live.error ?? "Could not estimate this app." });
          } else {
            out.push({ ...live.result, source: "on_demand" });
          }
        } catch (err: any) {
          // Per-item error, never a failed batch (spec §2.2).
          out.push({ store_id: storeId, error: err.message });
        }
      }
      // A single-id call keeps returning a single object, so existing callers don't break.
      return list.length === 1 && !ids ? out[0] : out;
    },
  },

  keyword_suggestions: {
    description: "Raw live store autocomplete for a prefix — the store's own ordering.",
    schema: { type: "object", properties: { q: { type: "string" }, store: STORE, country: COUNTRY }, required: ["q", "store"] },
    async run({ q: term, store, country = "us" }) {
      withSink();
      const terms = store === "ios" ? await appleAutocomplete(term, country) : await playSuggest(term, country);
      return terms.map((t: string, i: number) => ({ term: t, priority: i }));
    },
  },

  keyword_metrics: {
    description:
      "Popularity and difficulty for up to 25 keywords in one call. Stored metrics where the nightly crawl has them; otherwise a live autocomplete-depth popularity estimate (difficulty needs a crawl, so it may be null).",
    schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "One keyword" },
        qs: { type: "array", items: { type: "string" }, description: "Up to 25 keywords" },
        store: STORE,
        country: COUNTRY,
      },
      required: ["store"],
    },
    async run({ q: single, qs, store, country = "us" }) {
      const terms: string[] = (qs ?? (single ? [single] : [])).slice(0, 25);
      if (!terms.length) throw new ApiError("bad_request", "Pass q or qs.");
      withSink();

      const out = [];
      for (const term of terms) {
        try {
          const normalized = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
          const known = await q1<any>(
            `select term, popularity, popularity_estimate, difficulty, metrics_updated_at from keywords
              where term_normalized = $1 and platform = $2 and country = $3`,
            [normalized, store, country],
          );
          if (known && (known.popularity != null || known.popularity_estimate != null || known.difficulty != null)) {
            out.push({ ...known, source: "crawl" });
            continue;
          }
          const depth = await suggestDepth(term, country, store, store === "android" ? { playSuggest } : {});
          const scored = popularityProxy(depth);
          out.push({ term, popularity: null, popularity_estimate: scored.value, difficulty: null, source: "live_estimate" });
        } catch (err: any) {
          // Bulk returns 200 with a per-item error, never fails the batch (spec §2.2).
          out.push({ term, error: err.message });
        }
      }
      return out;
    },
  },

  top_charts: {
    description:
      "Store top charts. iOS: RSS feeds (topfreeapplications, topgrossingapplications, toppaidapplications). Android: Play category ranking — pass `category` (e.g. HEALTH_AND_FITNESS), which Play requires.",
    schema: {
      type: "object",
      properties: {
        store: STORE,
        country: COUNTRY,
        chart: { type: "string", description: "iOS feed type, default topfreeapplications. Ignored for Android." },
        category: { type: "string", description: "Android Play category id, default APPLICATION. Ignored for iOS." },
        limit: { type: "integer", description: "1-100, default 50" },
      },
      required: ["store"],
    },
    async run({ store, country = "us", chart = "topfreeapplications", category = "APPLICATION", limit = 50 }) {
      withSink();
      const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
      if (store === "ios") return appleChartsRSS(country, null, chart, n);
      // Play's chart endpoint is category-scoped and returns ~49 rows; the shape is
      // deliberately reported so a caller isn't surprised by a short "top 100".
      const rows = await playCategoryRanking(category, country);
      return rows.slice(0, n);
    },
  },

  // ── Workspace reads ───────────────────────────────────────────────────────
  list_apps: {
    description: "Every app this workspace tracks (own apps and competitors) with core metadata.",
    schema: { type: "object", properties: { cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const { n, after } = pageArgs(params);
      // Ratings live on app_snapshots, not apps — take the most recent snapshot per app.
      const rows = await q(
        `select ta.id as tracked_app_id, ta.role, a.store_id, a.platform, a.name, a.developer_name,
                a.version, s.rating_average, s.rating_count, s.captured_on
           from tracked_apps ta
           join apps a on a.id = ta.app_id
           left join lateral (
             select rating_average, rating_count, captured_on from app_snapshots
              where app_id = a.id order by captured_on desc limit 1
           ) s on true
          where ta.workspace_id = $1 and ta.is_active and ($2::uuid is null or ta.id > $2::uuid)
          order by ta.id limit $3`,
        [ws, after, n + 1],
      );
      return paged(rows, n, "tracked_app_id");
    },
  },

  list_competitors: {
    description: "Competitors tracked against one of your apps, with ratings, installs and any stored revenue estimate.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const { n, after } = pageArgs(params);
      const rows = await q(
        `select c.id as tracked_app_id, a.store_id, a.platform, a.name, a.developer_name, a.version,
                s.rating_average, s.rating_count, s.install_count,
                re.display as revenue_display, re.confidence as revenue_confidence
           from tracked_apps c
           join apps a on a.id = c.app_id
           left join lateral (
             select rating_average, rating_count, install_count from app_snapshots
              where app_id = a.id order by captured_on desc limit 1
           ) s on true
           left join lateral (
             select display, confidence from revenue_estimates
              where app_id = a.id order by estimated_on desc limit 1
           ) re on true
          where c.competitor_of = $1 and c.is_active and ($2::uuid is null or c.id > $2::uuid)
          order by c.id limit $3`,
        [app.id, after, n + 1],
      );
      return paged(rows, n, "tracked_app_id");
    },
  },

  app_keywords: {
    description: "Tracked keywords for an app with popularity, difficulty, current rank, and flags. Omit tracked_app_id for the primary app.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const { n, after } = pageArgs(params);
      // Ordered by tk.id, not by popularity: a cursor needs a stable unique column, and
      // popularity is rewritten by the nightly metrics job.
      const rows = await q(
        `select tk.id as tracked_keyword_id, k.id as keyword_id, k.term, k.country,
                k.popularity, k.popularity_estimate, k.difficulty,
                tk.is_branded, tk.starred, tk.note, tk.source,
                rc.rank, rc.found, rc.last_known_rank, rc.delta_7d, rc.best_rank, rc.checked_at
           from tracked_keywords tk
           join keywords k on k.id = tk.keyword_id
           left join ranking_current rc on rc.keyword_id = k.id and rc.app_id = $2
          where tk.tracked_app_id = $1 and ($3::bigint is null or tk.id > $3::bigint)
          order by tk.id limit $4`,
        [app.id, app.app_id, after, n + 1],
      );
      return paged(rows, n, "tracked_keyword_id");
    },
  },

  keyword_discoveries: {
    description: "Keywords discovery found that are NOT yet tracked, with source and opportunity score.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const { n, after } = pageArgs(params);
      const rows = await q(
        `select d.id as discovered_id, k.id as keyword_id, k.term, k.country, k.platform,
                d.source, d.relevance, d.opportunity, d.last_checked_at,
                k.popularity, k.popularity_estimate, k.difficulty
           from discovered_keywords d
           join keywords k on k.id = d.keyword_id
          where d.tracked_app_id = $1 and not d.dismissed
            and ($2::bigint is null or d.id > $2::bigint)
          order by d.id limit $3`,
        [app.id, after, n + 1],
      );
      return paged(rows, n, "discovered_id");
    },
  },

  app_rankings: {
    description: "Rank history for an app's tracked keywords over the last N days (default 30).",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, days: { type: "integer" }, cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const d = Math.min(Math.max(Number(params.days) || 30, 1), 365);
      const { n, after } = pageArgs(params, 200);
      const rows = await q(
        `select r.id as ranking_id, k.term, k.country, r.checked_on, r.rank, r.found, r.crawl_depth
           from rankings r join keywords k on k.id = r.keyword_id
          where r.app_id = $1 and r.checked_on >= current_date - $2::int
            and r.keyword_id in (select keyword_id from tracked_keywords where tracked_app_id = $3)
            and ($4::bigint is null or r.id > $4::bigint)
          order by r.id limit $5`,
        [app.app_id, d, app.id, after, n + 1],
      );
      return paged(rows, n, "ranking_id");
    },
  },

  keyword_rankings: {
    description: "Full rank history for ONE keyword against one app — the series behind a rankings chart.",
    schema: {
      type: "object",
      properties: { keyword: { type: "string" }, country: COUNTRY, tracked_app_id: { type: "string" }, days: { type: "integer" } },
      required: ["keyword"],
    },
    async run({ keyword, country = "us", tracked_app_id, days = 90 }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const normalized = String(keyword).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      const kw = await q1<{ id: string }>(
        `select id from keywords where term_normalized = $1 and platform = $2 and country = $3`,
        [normalized, app.platform, country],
      );
      if (!kw) throw new ApiError("not_found", `"${keyword}" is not a known keyword for ${app.platform}/${country}.`, 404);
      const d = Math.min(Math.max(Number(days) || 90, 1), 365);
      const history = await q(
        `select checked_on, rank, found, last_known_rank, crawl_depth from rankings
          where app_id = $1 and keyword_id = $2 and checked_on >= current_date - $3::int
          order by checked_on`,
        [app.app_id, kw.id, d],
      );
      const current = await q1(
        `select rank, found, last_known_rank, delta_1d, delta_7d, delta_30d, best_rank, best_rank_on, first_ranked_on
           from ranking_current where app_id = $1 and keyword_id = $2`,
        [app.app_id, kw.id],
      );
      return { keyword: normalized, country, app: { tracked_app_id: app.id, name: app.name }, current, history };
    },
  },

  serp_history: {
    description: "The most recent captured search-results page for a keyword: who ranks where, with their ratings.",
    schema: {
      type: "object",
      properties: { keyword: { type: "string" }, country: COUNTRY, tracked_app_id: { type: "string" } },
      required: ["keyword"],
    },
    async run({ keyword, country = "us", tracked_app_id }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const normalized = String(keyword).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      const kw = await q1<{ id: string }>(
        `select id from keywords where term_normalized = $1 and platform = $2 and country = $3`,
        [normalized, app.platform, country],
      );
      if (!kw) throw new ApiError("not_found", `"${keyword}" is not a known keyword for ${app.platform}/${country}.`, 404);
      const results = await q(
        `select sr.position, sr.rating_count, sr.rating_average, sr.title_match,
                a.name, a.store_id, a.developer_name, sr.captured_on
           from serp_results sr join apps a on a.id = sr.app_id
          where sr.keyword_id = $1
            and sr.captured_on = (select max(captured_on) from serp_results where keyword_id = $1)
          order by sr.position`,
        [kw.id],
      );
      if (!results.length) throw new ApiError("not_found", `No SERP captured for "${keyword}" yet — it needs one crawl pass.`, 404);
      return { keyword: normalized, country, captured_on: (results[0] as any).captured_on, results };
    },
  },

  app_changes: {
    description: "The activity feed: releases, metadata edits, price and category changes for tracked apps and competitors.",
    schema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["all", "own", "competitor"] }, cursor: CURSOR, limit: LIMIT },
    },
    async run(params) {
      const ws = await workspaceId();
      const { n, after } = pageArgs(params);
      const scope = params.scope === "own" || params.scope === "competitor" ? params.scope : null;
      const rows = await q(
        `select e.id as event_id, e.kind, e.field, e.old_value, e.new_value, e.release_notes,
                e.occurred_on, e.country, a.name as app_name, a.platform, ta.role
           from activity_events e
           join apps a on a.id = e.app_id
           join tracked_apps ta on ta.app_id = a.id and ta.is_active and ta.workspace_id = $1
          where ($2::text is null or ta.role = $2) and ($3::bigint is null or e.id > $3::bigint)
          order by e.id limit $4`,
        [ws, scope, after, n + 1],
      );
      return paged(rows, n, "event_id");
    },
  },

  app_reviews_stored: {
    description: "Crawled reviews for a TRACKED app, straight from the database (no live fetch). Filter by rating.",
    schema: {
      type: "object",
      properties: {
        tracked_app_id: { type: "string" },
        min_rating: { type: "integer", description: "1-5, default 1" },
        max_rating: { type: "integer", description: "1-5, default 5" },
        cursor: CURSOR,
        limit: LIMIT,
      },
    },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const { n, after } = pageArgs(params);
      const lo = Math.min(Math.max(Number(params.min_rating) || 1, 1), 5);
      const hi = Math.min(Math.max(Number(params.max_rating) || 5, 1), 5);
      const rows = await q(
        `select id as review_id, country, rating, title, body, author, app_version, helpful_count, reviewed_at
           from reviews
          where app_id = $1 and rating between $2 and $3 and ($4::bigint is null or id > $4::bigint)
          order by id limit $5`,
        [app.app_id, lo, hi, after, n + 1],
      );
      return paged(rows, n, "review_id");
    },
  },

  competitor_keywords: {
    description: "Keywords a specific tracked competitor ranks for, with their rank and yours side by side.",
    schema: {
      type: "object",
      properties: { competitor_tracked_app_id: { type: "string" }, tracked_app_id: { type: "string" }, cursor: CURSOR, limit: LIMIT },
      required: ["competitor_tracked_app_id"],
    },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const comp = await q1<any>(
        `select c.id, c.app_id, a.name from tracked_apps c join apps a on a.id = c.app_id
          where c.id = $1 and c.workspace_id = $2 and c.is_active`,
        [params.competitor_tracked_app_id, ws],
      );
      if (!comp) throw new ApiError("not_found", "No such competitor in this workspace.", 404);
      const { n, after } = pageArgs(params);
      const rows = await q(
        `select tk.id as tracked_keyword_id, k.term, k.country, k.popularity, k.popularity_estimate, k.difficulty,
                theirs.rank as their_rank, ours.rank as our_rank
           from tracked_keywords tk
           join keywords k on k.id = tk.keyword_id
           join ranking_current theirs on theirs.keyword_id = k.id and theirs.app_id = $2
           left join ranking_current ours on ours.keyword_id = k.id and ours.app_id = $3
          where tk.tracked_app_id = $1 and theirs.rank is not null
            and ($4::bigint is null or tk.id > $4::bigint)
          order by tk.id limit $5`,
        [app.id, comp.app_id, app.app_id, after, n + 1],
      );
      return { competitor: { tracked_app_id: comp.id, name: comp.name }, ...paged(rows, n, "tracked_keyword_id") };
    },
  },

  competitor_landscape: {
    description: "Stored AI competitive analyses for an app (posture, opportunities, threats, strengths), newest first.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, limit: { type: "integer" } } },
    async run({ tracked_app_id, limit = 5 }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      return q(
        `select id, kind, posture, opportunities, threats, strengths, model, created_at
           from ai_analyses where tracked_app_id = $1 order by created_at desc limit $2`,
        [app.id, Math.min(Math.max(Number(limit) || 5, 1), 25)],
      );
    },
  },

  competitive_positions: {
    description: "The keyword-level competitive picture: gaps, winnable-now, threats, and leads vs tracked competitors.",
    schema: {
      type: "object",
      properties: {
        tracked_app_id: { type: "string" },
        bucket: { type: "string", enum: ["gap", "winnable", "threat", "lead"] },
        cursor: CURSOR,
        limit: LIMIT,
      },
    },
    async run(params) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, params.tracked_app_id);
      const { n, after } = pageArgs(params);
      const rows = await q(
        `select cp.id as position_id, k.term, k.country, cp.bucket, cp.their_rank, cp.our_rank, cp.opportunity,
                k.popularity, k.popularity_estimate, k.difficulty,
                ca.name as competitor_name
           from competitive_positions cp
           join keywords k on k.id = cp.keyword_id
           left join apps ca on ca.id = cp.best_competitor_app_id
          where cp.tracked_app_id = $1 and ($2::text is null or cp.bucket = $2)
            and ($3::bigint is null or cp.id > $3::bigint)
          order by cp.id limit $4`,
        [app.id, params.bucket ?? null, after, n + 1],
      );
      return paged(rows, n, "position_id");
    },
  },

  list_alerts: {
    description: "The alert feed (rank drops, new rankings, competitor changes...), oldest first with a cursor.",
    schema: { type: "object", properties: { cursor: CURSOR, limit: LIMIT } },
    async run(params) {
      const ws = await workspaceId();
      const { n, after } = pageArgs(params, 30);
      const rows = await q(
        `select id as alert_id, kind, message, country, platform, from_rank, to_rank, occurred_on, read_at
           from alerts
          where workspace_id = $1 and ($2::bigint is null or id > $2::bigint)
          order by id limit $3`,
        [ws, after, n + 1],
      );
      return paged(rows, n, "alert_id");
    },
  },

  list_alert_rules: {
    description: "Which alert kinds are on for this workspace, and their thresholds.",
    schema: { type: "object", properties: {} },
    async run() {
      const ws = await workspaceId();
      return q(`select kind, enabled, threshold from alert_settings where workspace_id = $1 order by kind`, [ws]);
    },
  },

  // ── Writes (kept behind the write scope) ─────────────────────────────────
  track_keywords: {
    description: "Track new keywords for an app. Terms are trimmed, deduped and idempotent. Omit tracked_app_id for the primary app.",
    schema: {
      type: "object",
      properties: {
        keywords: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" }, description: "default ['us']" },
        tracked_app_id: { type: "string" },
      },
      required: ["keywords"],
    },
    write: true,
    async run({ keywords, countries = ["us"], tracked_app_id }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const { addKeywords } = await import("@/app/actions/keywords");
      return addKeywords(app.id, keywords, countries);
    },
  },

  star_keyword: {
    description: "Star or unstar a tracked keyword by tracked_keyword_id.",
    schema: {
      type: "object",
      properties: { tracked_keyword_id: { type: "string" }, starred: { type: "boolean" } },
      required: ["tracked_keyword_id", "starred"],
    },
    write: true,
    async run({ tracked_keyword_id, starred }) {
      const { starKeyword } = await import("@/app/actions/keywords");
      await starKeyword(tracked_keyword_id, Boolean(starred));
      return { ok: true };
    },
  },

  set_keyword_note: {
    description: "Attach a note (or null to clear) to a tracked keyword by tracked_keyword_id.",
    schema: {
      type: "object",
      properties: { tracked_keyword_id: { type: "string" }, note: { type: ["string", "null"] } },
      required: ["tracked_keyword_id"],
    },
    write: true,
    async run({ tracked_keyword_id, note }) {
      const { setKeywordNote } = await import("@/app/actions/keywords");
      await setKeywordNote(tracked_keyword_id, note ?? null);
      return { ok: true };
    },
  },

  untrack_keywords: {
    description: "Stop tracking keywords by tracked_keyword_id. Accepts one id or many; measured history is kept.",
    schema: {
      type: "object",
      properties: {
        tracked_keyword_id: { type: "string" },
        tracked_keyword_ids: { type: "array", items: { type: "string" } },
      },
    },
    write: true,
    async run({ tracked_keyword_id, tracked_keyword_ids }) {
      const ids: string[] = tracked_keyword_ids ?? (tracked_keyword_id ? [tracked_keyword_id] : []);
      if (!ids.length) throw new ApiError("bad_request", "Pass tracked_keyword_id or tracked_keyword_ids.");
      const { untrackKeywords } = await import("@/app/actions/keywords");
      return untrackKeywords(ids);
    },
  },

  find_app: {
    description:
      "Resolve anything that identifies an app — store URL, numeric App Store id, bundle id / package name, or a name — into candidate store listings. Read-only; pick one and pass it to track_app.",
    schema: {
      type: "object",
      properties: { query: { type: "string" }, store: STORE, country: COUNTRY },
      required: ["query"],
    },
    async run({ query, store, country = "us" }) {
      const { findApp } = await import("@/app/actions/apps");
      return findApp(query, { store: store ?? null, country });
    },
  },

  track_app: {
    description: "Start tracking an app as one of your own. Use find_app first to get the exact store and store_id.",
    schema: {
      type: "object",
      properties: { store: STORE, store_id: { type: "string" }, country: COUNTRY },
      required: ["store", "store_id"],
    },
    write: true,
    async run({ store, store_id, country = "us" }) {
      const { trackApp } = await import("@/app/actions/apps");
      try {
        return await trackApp({ store, storeId: String(store_id), country, role: "own" });
      } catch (err) {
        // The only failure trackApp raises is "could not fetch that listing" — a bad id.
        throw new ApiError("not_found", (err as Error).message, 404);
      }
    },
  },

  add_competitor: {
    description: "Track an app as a competitor of one of your own apps. Omit tracked_app_id for the primary app.",
    schema: {
      type: "object",
      properties: { store: STORE, store_id: { type: "string" }, country: COUNTRY, tracked_app_id: { type: "string" } },
      required: ["store", "store_id"],
    },
    write: true,
    async run({ store, store_id, country = "us", tracked_app_id }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const { trackApp } = await import("@/app/actions/apps");
      try {
        return await trackApp({ store, storeId: String(store_id), country, role: "competitor", competitorOf: app.id });
      } catch (err) {
        throw new ApiError("not_found", (err as Error).message, 404);
      }
    },
  },

  untrack_app: {
    description:
      "Stop tracking an app or competitor by tracked_app_id. Cascades to its keywords, discoveries, competitors and drafts; shared store measurements are kept.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" } }, required: ["tracked_app_id"] },
    write: true,
    async run({ tracked_app_id }) {
      // Check ownership here so an unknown id is a typed 404 rather than the Server Action's
      // plain Error surfacing as a 500 — an agent needs to tell "wrong id" from "we broke".
      const ws = await workspaceId();
      const row = await q1(`select id from tracked_apps where id = $1 and workspace_id = $2`, [tracked_app_id, ws]);
      if (!row) throw new ApiError("not_found", "No such tracked app in this workspace.", 404);
      const { untrackApp } = await import("@/app/actions/apps");
      return untrackApp(tracked_app_id);
    },
  },

  set_alert_rule: {
    description:
      "Turn an alert kind on or off and set its threshold. Kinds: rank_drop, out_of_top10, new_ranking, rank_gain, entered_top10, rating_drop, review_spike, competitor_change.",
    schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["rank_drop", "out_of_top10", "new_ranking", "rank_gain", "entered_top10", "rating_drop", "review_spike", "competitor_change"],
        },
        enabled: { type: "boolean" },
        threshold: { type: ["integer", "null"], description: "rank_drop: minimum drop to fire on" },
      },
      required: ["kind", "enabled"],
    },
    write: true,
    async run({ kind, enabled, threshold }) {
      const ws = await workspaceId();
      // The CHECK constraint on alert_settings.kind is the allowlist — a bad kind fails loudly.
      await q(
        `insert into alert_settings (workspace_id, kind, enabled, threshold) values ($1,$2,$3,$4)
         on conflict (workspace_id, kind) do update set enabled = excluded.enabled, threshold = excluded.threshold`,
        [ws, kind, Boolean(enabled), threshold ?? null],
      );
      return { kind, enabled: Boolean(enabled), threshold: threshold ?? null };
    },
  },

  delete_alert_rule: {
    description: "Remove an alert rule entirely, returning that kind to its default (off).",
    schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
    write: true,
    async run({ kind }) {
      const ws = await workspaceId();
      const gone = await q(`delete from alert_settings where workspace_id = $1 and kind = $2 returning kind`, [ws, kind]);
      return { removed: gone.length > 0 };
    },
  },

  add_annotation: {
    description: "Mark a dated event on an app's rankings chart, e.g. 'Shipped v2.0' or 'Started Apple Search Ads'.",
    schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        occurred_on: { type: "string", description: "YYYY-MM-DD, default today" },
        tracked_app_id: { type: "string" },
      },
      required: ["label"],
    },
    write: true,
    async run({ label, occurred_on, tracked_app_id }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const text = String(label).trim().slice(0, 200);
      if (!text) throw new ApiError("bad_request", "label cannot be empty.");
      const row = await q1(
        `insert into annotations (tracked_app_id, occurred_on, label, auto)
         values ($1, coalesce($2::date, current_date), $3, false)
         returning id, occurred_on, label`,
        [app.id, occurred_on ?? null, text],
      );
      return row;
    },
  },

  promote_discovered: {
    description: "Promote discovered keywords to tracked, by discovered_id. Accepts one or many.",
    schema: {
      type: "object",
      properties: {
        discovered_id: { type: "string" },
        discovered_ids: { type: "array", items: { type: "string" } },
      },
    },
    write: true,
    async run({ discovered_id, discovered_ids }) {
      const ids: string[] = discovered_ids ?? (discovered_id ? [discovered_id] : []);
      if (!ids.length) throw new ApiError("bad_request", "Pass discovered_id or discovered_ids.");
      const { promoteDiscovered } = await import("@/app/actions/keywords");
      return promoteDiscovered(ids);
    },
  },
};
