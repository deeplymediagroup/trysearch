/**
 * /api/v1 — the public REST surface (05-API-ROUTES.md §2). One catch-all handler mapping
 * paths onto the shared op registry; the MCP server exposes the same ops as tools.
 *
 * Envelope: { data } on success, { error: { code, message } } on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { OPS, ApiError } from "@/lib/api-core";
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
  "competitive-positions": "competitive_positions",
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

    const data = await OPS[opName].run(params);
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
      const data = await OPS.track_keywords.run({ ...body, tracked_app_id: path[1] });
      return NextResponse.json({ data }, { status: 201, headers });
    }
    // POST /tracked-keywords/{id} → note / star
    if (path[0] === "tracked-keywords" && path.length === 2) {
      if (typeof body.starred === "boolean") await OPS.star_keyword.run({ tracked_keyword_id: path[1], starred: body.starred });
      if ("note" in body) await OPS.set_keyword_note.run({ tracked_keyword_id: path[1], note: body.note });
      return NextResponse.json({ data: { ok: true } }, { headers });
    }

    throw new ApiError("not_found", `No such endpoint: POST /api/v1/${path.join("/")}`, 404);
  } catch (err) {
    return fail(err, headers);
  }
}
