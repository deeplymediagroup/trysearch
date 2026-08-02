/**
 * /api/v1 — the public REST surface (05-API-ROUTES.md §2). One catch-all handler mapping
 * paths onto the shared op registry; the MCP server exposes the same ops as tools.
 *
 * Envelope: { data } on success, { error: { code, message } } on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { OPS, ApiError, runOp } from "@/lib/api-core";
import { authenticate, rateLimitHeaders } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET path → op name. Query string params pass straight through. */
const GET_ROUTES: Record<string, string> = {
  "apps/lookup": "app_lookup",
  "apps/search": "app_search",
  "apps/aso-score": "app_aso_score",
  "apps/extract-keywords": "app_extract_keywords",
  "apps/reviews": "app_reviews",
  "apps/revenue": "app_revenue",
  "keywords/suggestions": "keyword_suggestions",
  "keywords/metrics": "keyword_metrics",
  "charts/top": "top_charts",
  apps: "list_apps",
  alerts: "list_alerts",
  "alert-rules": "list_alert_rules",
  "competitive-positions": "competitive_positions",
  competitors: "list_competitors",
  discoveries: "keyword_discoveries",
  changes: "app_changes",
  "keywords/rankings": "keyword_rankings",
  "keywords/serp": "serp_history",
  "competitor-keywords": "competitor_keywords",
  "competitor-landscape": "competitor_landscape",
  "apps/find": "find_app",
  reviews: "app_reviews_stored",
};

function fail(err: unknown, headers: Record<string, string> = {}) {
  const e = err instanceof ApiError ? err : new ApiError("internal_error", (err as Error).message ?? "Unexpected error.", 500);
  return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  let headers: Record<string, string> = {};
  try {
    const id = await authenticate(req);
    headers = rateLimitHeaders(id);
    const { path } = await ctx.params;
    const joined = path.join("/");

    const params: Record<string, unknown> = Object.fromEntries(req.nextUrl.searchParams.entries());
    if (typeof params.qs === "string") params.qs = (params.qs as string).split(",").map((s) => s.trim()).filter(Boolean);

    // Nested reads: apps/{tracked_app_id}/keywords | rankings
    let opName = GET_ROUTES[joined];
    if (!opName && path[0] === "apps" && path.length === 3) {
      const sub: Record<string, string> = { keywords: "app_keywords", rankings: "app_rankings" };
      opName = sub[path[2]];
      if (opName) params.tracked_app_id = path[1];
    }
    if (!opName) throw new ApiError("not_found", `No such endpoint: GET /api/v1/${joined}`, 404);

    const data = await runOp(opName, params, id);
    return NextResponse.json({ data }, { headers });
  } catch (err) {
    return fail(err, headers);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  let headers: Record<string, string> = {};
  try {
    const id = await authenticate(req);
    headers = rateLimitHeaders(id);
    const { path } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    // POST /apps/{tracked_app_id}/keywords → track_keywords
    if (path[0] === "apps" && path.length === 3 && path[2] === "keywords") {
      const data = await runOp("track_keywords", { ...body, tracked_app_id: path[1] }, id);
      return NextResponse.json({ data }, { status: 201, headers });
    }
    // POST /tracked-keywords/{id} → note / star
    if (path[0] === "tracked-keywords" && path.length === 2) {
      if (typeof body.starred === "boolean") await runOp("star_keyword", { tracked_keyword_id: path[1], starred: body.starred }, id);
      if ("note" in body) await runOp("set_keyword_note", { tracked_keyword_id: path[1], note: body.note }, id);
      return NextResponse.json({ data: { ok: true } }, { headers });
    }
    // POST /ops/{op_name} → any write op by name, body as params. One route rather than a
    // bespoke path per verb: the registry already names and validates every operation.
    if (path[0] === "ops" && path.length === 2) {
      const data = await runOp(path[1], body, id);
      return NextResponse.json({ data }, { headers });
    }

    throw new ApiError("not_found", `No such endpoint: POST /api/v1/${path.join("/")}`, 404);
  } catch (err) {
    return fail(err, headers);
  }
}
