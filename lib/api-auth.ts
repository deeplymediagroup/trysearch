/**
 * Bearer-token auth for /api/v1 and /mcp. Tokens live in api_keys as SHA-256 hashes —
 * the full value is shown once at creation (scripts/create-api-key.mjs) and never stored.
 */
import { createHash } from "crypto";
import { q, q1 } from "@/lib/db";
import { ApiError } from "@/lib/api-core";

export type ApiIdentity = {
  key_id: string;
  workspace_id: string;
  /** 'read' refuses every op marked `write: true`. Enforced centrally in runOp(). */
  scope: "read" | "write";
  limit: number;
  remaining: number;
};

export async function authenticate(req: Request): Promise<ApiIdentity> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new ApiError("unauthorized", "Missing or invalid Authorization header.", 401);

  const hash = createHash("sha256").update(token).digest("hex");
  const key = await q1<{ id: string; workspace_id: string; scope: "read" | "write"; requests_per_day: number }>(
    `select id, workspace_id, scope, requests_per_day from api_keys
      where token_hash = $1 and revoked_at is null`,
    [hash],
  );
  if (!key) throw new ApiError("unauthorized", "Unknown or revoked API key.", 401);

  const usage = await q1<{ requests: number }>(
    `insert into api_usage (api_key_id, used_on, requests) values ($1, current_date, 1)
     on conflict (api_key_id, used_on) do update set requests = api_usage.requests + 1
     returning requests`,
    [key.id],
  );
  const used = usage?.requests ?? 1;
  if (used > key.requests_per_day) throw new ApiError("rate_limited", `Daily limit of ${key.requests_per_day} requests exceeded.`, 429);

  await q(`update api_keys set last_used_at = now() where id = $1`, [key.id]);

  return {
    key_id: key.id,
    workspace_id: key.workspace_id,
    scope: key.scope === "write" ? "write" : "read",
    limit: key.requests_per_day,
    remaining: Math.max(0, key.requests_per_day - used),
  };
}

export function rateLimitHeaders(id: ApiIdentity): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(id.limit),
    "X-RateLimit-Remaining": String(id.remaining),
    "X-RateLimit-Reset": new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
  };
}
