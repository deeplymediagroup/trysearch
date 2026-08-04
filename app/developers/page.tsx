/**
 * /developers — the API reference, rendered FROM the op registry (lib/api-core.ts) so the
 * docs cannot drift from the code: every op's name, description, params and scope come
 * straight from OPS at render time.
 */
import { AppShell, PageHeader } from "@/components/AppShell";
import { OPS } from "@/lib/api-core";

export const metadata = { title: "API — trysearch" };

/**
 * Convenience GET aliases. These mirror GET_ROUTES in app/api/v1/[...path]/route.ts
 * (which a route file cannot export). Every op — aliased or not — is always callable as
 * POST /api/v1/ops/{op_name}, so a missing alias here never hides an op below.
 */
const GET_ALIASES: Record<string, string> = {
  app_lookup: "GET /api/v1/apps/lookup",
  app_search: "GET /api/v1/apps/search",
  app_aso_score: "GET /api/v1/apps/aso-score",
  app_extract_keywords: "GET /api/v1/apps/extract-keywords",
  app_reviews: "GET /api/v1/apps/reviews",
  app_revenue: "GET /api/v1/apps/revenue",
  keyword_suggestions: "GET /api/v1/keywords/suggestions",
  keyword_metrics: "GET /api/v1/keywords/metrics",
  top_charts: "GET /api/v1/charts/top",
  list_apps: "GET /api/v1/apps",
  list_alerts: "GET /api/v1/alerts",
  list_alert_rules: "GET /api/v1/alert-rules",
  competitive_positions: "GET /api/v1/competitive-positions",
  list_competitors: "GET /api/v1/competitors",
  keyword_discoveries: "GET /api/v1/discoveries",
  app_changes: "GET /api/v1/changes",
  keyword_rankings: "GET /api/v1/keywords/rankings",
  serp_history: "GET /api/v1/keywords/serp",
  competitor_keywords: "GET /api/v1/competitor-keywords",
  competitor_landscape: "GET /api/v1/competitor-landscape",
  find_app: "GET /api/v1/apps/find",
  app_reviews_stored: "GET /api/v1/reviews",
  app_keywords: "GET /api/v1/apps/{tracked_app_id}/keywords",
  app_rankings: "GET /api/v1/apps/{tracked_app_id}/rankings",
};

function typeOf(prop: any): string {
  const t = prop?.type;
  if (Array.isArray(t)) return t.join("|");
  if (t === "array") return `${prop.items?.type ?? "any"}[]`;
  return String(t ?? "any");
}

export default async function DevelopersPage() {
  const ops = Object.entries(OPS);
  return (
    <AppShell current="/developers">
      <PageHeader title="API" subtitle={`REST + MCP over one registry of ${ops.length} operations. This page is generated from that registry.`} />
      <div className="max-w-3xl space-y-8 px-6 pb-12">
        <section className="space-y-2 text-[13px] text-[var(--fg-muted)]">
          <h2 className="th">Auth &amp; envelope</h2>
          <p>
            Every request: <code className="num">Authorization: Bearer ts_...</code> — mint a key with{" "}
            <code className="num">node scripts/create-api-key.mjs &quot;name&quot; [--scope write]</code>. Keys are{" "}
            <strong>read</strong> by default; ops marked <em>write</em> below need a write-scoped key and return 403 otherwise.
          </p>
          <p>
            Success: <code className="num">{`{ "data": ... }`}</code> · failure:{" "}
            <code className="num">{`{ "error": { "code", "message" } }`}</code>.
          </p>
          <h2 className="th pt-2">Calling an op</h2>
          <p>
            Canonical form, works for every op: <code className="num">POST /api/v1/ops/{"{op_name}"}</code> with the params as a JSON
            body. Many read ops also have a GET alias (shown per op) taking the same params as query string;{" "}
            <code className="num">qs</code> accepts a comma-separated list on GET.
          </p>
          <h2 className="th pt-2">Pagination</h2>
          <p>
            List ops return <code className="num">{`{ items, pagination: { next_cursor, has_more } }`}</code>. Pass{" "}
            <code className="num">cursor=next_cursor</code> to get the next page. Cursors are keyset-based — stable under concurrent
            inserts and deletes.
          </p>
          <h2 className="th pt-2">MCP</h2>
          <pre className="num overflow-x-auto rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-hover)] p-2.5 text-[12px]">
            {`claude mcp add --transport http trysearch https://<host>/mcp --header "Authorization: Bearer ts_..."`}
          </pre>
          <p>The MCP server exposes exactly these operations as tools, with the same schemas.</p>
        </section>

        <section className="space-y-4">
          <h2 className="th">Operations</h2>
          {ops.map(([name, op]) => (
            <div key={name} className="rounded-[var(--radius-chip)] border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="num text-[13px] font-semibold">{name}</h3>
                {op.write && (
                  <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">write</span>
                )}
              </div>
              <p className="mt-1 text-[12.5px] text-[var(--fg-muted)]">{op.description}</p>
              <p className="num mt-1.5 text-[11.5px] text-[var(--fg-subtle)]">
                POST /api/v1/ops/{name}
                {GET_ALIASES[name] ? ` · ${GET_ALIASES[name]}` : ""}
              </p>
              {Object.keys(op.schema.properties).length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {Object.entries(op.schema.properties).map(([param, prop]: [string, any]) => (
                    <li key={param} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                      <code className="num">{param}</code>
                      <span className="text-[11px] text-[var(--fg-subtle)]">{typeOf(prop)}</span>
                      {op.schema.required?.includes(param) && <span className="text-[10px] font-medium text-[var(--accent)]">required</span>}
                      {prop?.description && <span className="text-[var(--fg-muted)]">{prop.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
