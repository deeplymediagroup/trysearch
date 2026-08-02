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
import { playAppDetail, playSearchRanked, playSuggest, extractListingKeywords } from "@/lib/stores/play.mjs";
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
    description: "Latest stored revenue estimate for a tracked app, with the model and confidence.",
    schema: { type: "object", properties: { store: STORE, id: { type: "string" } }, required: ["store", "id"] },
    async run({ store, id }) {
      const row = await q1(
        `select a.name, a.store_id, re.model, re.confidence, re.monthly_usd_low, re.monthly_usd_high, re.display, re.factors, re.estimated_on
           from apps a join revenue_estimates re on re.app_id = a.id
          where a.store_id = $1 and a.platform = $2
          order by re.estimated_on desc limit 1`,
        [id, store],
      );
      if (!row) throw new ApiError("not_found", "No revenue estimate stored — the app isn't in the crawl set.", 404);
      return row;
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
    description: "Store top charts (iOS RSS feeds: topfreeapplications, topgrossingapplications, toppaidapplications).",
    schema: {
      type: "object",
      properties: {
        store: STORE,
        country: COUNTRY,
        chart: { type: "string", description: "iOS feed type, default topfreeapplications" },
        limit: { type: "integer", description: "1-100, default 50" },
      },
      required: ["store"],
    },
    async run({ store, country = "us", chart = "topfreeapplications", limit = 50 }) {
      if (store !== "ios") throw new ApiError("bad_request", "Charts are iOS-only in v1 (Play's endpoint returns ~49 uncategorised rows).");
      withSink();
      const rows = await appleChartsRSS(country, null, chart, Math.min(Number(limit) || 50, 100));
      return rows;
    },
  },

  // ── Workspace reads ───────────────────────────────────────────────────────
  list_apps: {
    description: "Every app this workspace tracks (own apps and competitors) with core metadata.",
    schema: { type: "object", properties: {} },
    async run() {
      const ws = await workspaceId();
      // Ratings live on app_snapshots, not apps — take the most recent snapshot per app.
      return q(
        `select ta.id as tracked_app_id, ta.role, a.store_id, a.platform, a.name, a.developer_name,
                a.version, s.rating_average, s.rating_count, s.captured_on
           from tracked_apps ta
           join apps a on a.id = ta.app_id
           left join lateral (
             select rating_average, rating_count, captured_on from app_snapshots
              where app_id = a.id order by captured_on desc limit 1
           ) s on true
          where ta.workspace_id = $1 and ta.is_active order by ta.role, a.name`,
        [ws],
      );
    },
  },

  app_keywords: {
    description: "Tracked keywords for an app with popularity, difficulty, current rank, and flags. Omit tracked_app_id for the primary app.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" } } },
    async run({ tracked_app_id }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      return q(
        `select tk.id as tracked_keyword_id, k.id as keyword_id, k.term, k.country,
                k.popularity, k.popularity_estimate, k.difficulty,
                tk.is_branded, tk.starred, tk.note, tk.source,
                rc.rank, rc.found, rc.last_known_rank, rc.delta_7d, rc.best_rank, rc.checked_at
           from tracked_keywords tk
           join keywords k on k.id = tk.keyword_id
           left join ranking_current rc on rc.keyword_id = k.id and rc.app_id = $2
          where tk.tracked_app_id = $1
          order by coalesce(k.popularity, k.popularity_estimate, 0) desc`,
        [app.id, app.app_id],
      );
    },
  },

  app_rankings: {
    description: "Rank history for an app's tracked keywords over the last N days (default 30).",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, days: { type: "integer" } } },
    async run({ tracked_app_id, days = 30 }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      const d = Math.min(Math.max(Number(days) || 30, 1), 365);
      return q(
        `select k.term, k.country, r.checked_on, r.rank
           from rankings r join keywords k on k.id = r.keyword_id
          where r.app_id = $1 and r.checked_on >= current_date - $2::int
            and r.keyword_id in (select keyword_id from tracked_keywords where tracked_app_id = $3)
          order by k.term, r.checked_on`,
        [app.app_id, d, app.id],
      );
    },
  },

  competitive_positions: {
    description: "The keyword-level competitive picture: gaps, winnable-now, threats, and leads vs tracked competitors.",
    schema: { type: "object", properties: { tracked_app_id: { type: "string" }, bucket: { type: "string", enum: ["gap", "winnable", "threat", "lead"] } } },
    async run({ tracked_app_id, bucket }) {
      const ws = await workspaceId();
      const app = await resolveTrackedApp(ws, tracked_app_id);
      return q(
        `select k.term, k.country, cp.bucket, cp.their_rank, cp.our_rank, cp.opportunity,
                k.popularity, k.popularity_estimate, k.difficulty,
                ca.name as competitor_name
           from competitive_positions cp
           join keywords k on k.id = cp.keyword_id
           left join apps ca on ca.id = cp.best_competitor_app_id
          where cp.tracked_app_id = $1 and ($2::text is null or cp.bucket = $2)
          order by cp.opportunity desc nulls last limit 100`,
        [app.id, bucket ?? null],
      );
    },
  },

  list_alerts: {
    description: "The most recent alert feed entries (rank drops, new rankings, competitor changes...).",
    schema: { type: "object", properties: { limit: { type: "integer" } } },
    async run({ limit = 30 }) {
      const ws = await workspaceId();
      return q(
        `select kind, message, country, platform, occurred_on from alerts
          where workspace_id = $1 order by occurred_on desc, id desc limit $2`,
        [ws, Math.min(Number(limit) || 30, 100)],
      );
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
};
