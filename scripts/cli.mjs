#!/usr/bin/env node
/**
 * trysearch CLI — a thin, dependency-free client for the deployed REST API.
 *
 *   node scripts/cli.mjs <op> --key <API_KEY> --base <url> [--param value ...]
 *   node scripts/cli.mjs --list
 *
 * Every op is called as POST /api/v1/ops/<op> with the flags as the JSON body
 * (the canonical form in app/api/v1/[...path]/route.ts — one route, any op).
 * --key/--base fall back to TRYSEARCH_API_KEY / TRYSEARCH_BASE_URL.
 *
 * Examples:
 *   node scripts/cli.mjs app_search --key ts_... --base https://myhost --q "habit tracker" --store ios
 *   node scripts/cli.mjs keyword_metrics --qs '["habit tracker","daily planner"]' --store ios
 *   node scripts/cli.mjs list_apps
 */

// ponytail: hardcoded from lib/api-core.ts OPS — the API has no public index endpoint.
// If ops are added, append here (or add an index op and fetch it instead).
const KNOWN_OPS = {
  app_search: "Search a store for apps by name",
  app_lookup: "Full public app record by store id",
  app_aso_score: "0-100 ASO listing audit with nine checks",
  app_extract_keywords: "Keywords an app's listing targets",
  app_reviews: "Recent public reviews (live fetch)",
  app_revenue: "Estimated monthly revenue for one or many apps",
  keyword_suggestions: "Raw live store autocomplete",
  keyword_metrics: "Popularity + difficulty, computed live if never seen",
  top_charts: "Store top charts",
  list_apps: "Apps this workspace tracks",
  list_competitors: "Competitors of one of your apps",
  app_keywords: "Tracked keywords with metrics and rank",
  keyword_discoveries: "Discovered-but-untracked keywords",
  app_rankings: "Rank history for tracked keywords",
  keyword_rankings: "Full rank history for one keyword",
  serp_history: "Most recent captured SERP for a keyword",
  app_changes: "Activity feed: releases, edits, price changes",
  app_reviews_stored: "Crawled reviews from the database",
  competitor_keywords: "A competitor's keywords, their rank vs yours",
  competitor_landscape: "Stored AI competitive analyses",
  competitive_positions: "Gaps / winnable / threats / leads",
  list_alerts: "The alert feed",
  list_alert_rules: "Alert kinds and thresholds",
  track_keywords: "Track new keywords (write)",
  star_keyword: "Star or unstar a tracked keyword (write)",
  set_keyword_note: "Attach a note to a tracked keyword (write)",
  untrack_keywords: "Stop tracking keywords (write)",
  find_app: "Resolve a URL / id / name into store listings",
  track_app: "Start tracking an app as your own (write)",
  add_competitor: "Track an app as a competitor (write)",
  untrack_app: "Stop tracking an app (write)",
  set_alert_rule: "Turn an alert kind on/off (write)",
  delete_alert_rule: "Remove an alert rule (write)",
  add_annotation: "Mark a dated event on the chart (write)",
  promote_discovered: "Promote discovered keywords to tracked (write)",
};

function parseArgs(argv) {
  let op = null;
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else if (!op) {
      op = a;
    }
  }
  return { op, flags };
}

/** "12" → 12, "true" → true, '["a","b"]' → array, anything else → string. */
function coerce(v) {
  if (v === true) return true;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function printTable(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
    (c) => rows.some((r) => r[c] != null && typeof r[c] !== "object"),
  );
  const cell = (r, c) => (r[c] == null ? "" : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c]));
  const widths = cols.map((c) => Math.min(40, Math.max(c.length, ...rows.map((r) => cell(r, c).length))));
  const line = (vals) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => cell(r, c))));
}

function printData(data) {
  if (Array.isArray(data) && data.length && data.every((r) => r && typeof r === "object")) return printTable(data);
  if (data && Array.isArray(data.items)) {
    if (data.items.length) printTable(data.items);
    else console.log("(no rows)");
    if (data.pagination?.has_more) console.log(`\nMore pages — pass --cursor ${data.pagination.next_cursor}`);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

const { op, flags } = parseArgs(process.argv.slice(2));

if (flags.list || op === "--list") {
  const w = Math.max(...Object.keys(KNOWN_OPS).map((k) => k.length));
  for (const [name, desc] of Object.entries(KNOWN_OPS)) console.log(`${name.padEnd(w)}  ${desc}`);
  process.exit(0);
}

if (!op || flags.help) {
  console.log("Usage: node scripts/cli.mjs <op> --key <API_KEY> --base <url> [--param value ...]");
  console.log("       node scripts/cli.mjs --list");
  process.exit(op ? 0 : 1);
}

const key = flags.key ?? process.env.TRYSEARCH_API_KEY;
const base = (flags.base ?? process.env.TRYSEARCH_BASE_URL ?? "").replace(/\/+$/, "");
if (!key || !base) {
  console.error("Need --key and --base (or TRYSEARCH_API_KEY / TRYSEARCH_BASE_URL).");
  process.exit(1);
}
if (!KNOWN_OPS[op]) console.error(`Warning: "${op}" is not a known op (see --list) — sending anyway.`);

const params = {};
for (const [k, v] of Object.entries(flags)) {
  if (k === "key" || k === "base" || k === "list" || k === "help") continue;
  params[k] = coerce(v);
}

const res = await fetch(`${base}/api/v1/ops/${op}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(params),
});
const body = await res.json().catch(() => null);

if (!res.ok || body?.error) {
  console.error(`Error ${res.status}: ${body?.error?.code ?? ""} ${body?.error?.message ?? res.statusText}`);
  process.exit(1);
}
printData(body.data);
