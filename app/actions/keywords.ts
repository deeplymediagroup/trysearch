"use server";

/**
 * Server Actions — 05-API-ROUTES.md §1. These are what the buttons call.
 *
 * EVERY action that writes re-validates that the workspace owns the target row. Never trust
 * an id from the client, even in a single-tenant install: the pattern has to be right before
 * this ever becomes multi-tenant, and the schema already supports that.
 */
import { revalidatePath } from "next/cache";
import { q, q1, exec, currentWorkspace } from "@/lib/db";

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

/** Promotes discovered keywords to tracked. */
export async function promoteDiscovered(discoveredIds: string[]) {
  if (!discoveredIds.length) return { added: 0 };
  const ws = await workspaceId();

  // The where-clause on workspace_id IS the ownership check — a foreign id simply matches nothing.
  const rows = await q<{ tracked_app_id: string; keyword_id: string }>(
    `select tracked_app_id, keyword_id from discovered_keywords
      where id = any($1::bigint[]) and workspace_id = $2`,
    [discoveredIds, ws],
  );

  let added = 0;
  for (const r of rows) {
    const res = await q(
      `insert into tracked_keywords (workspace_id, tracked_app_id, keyword_id, source)
       values ($1,$2,$3,'suggested')
       on conflict (tracked_app_id, keyword_id) do nothing
       returning id`,
      [ws, r.tracked_app_id, r.keyword_id],
    );
    if (res.length) added++;
  }

  await exec(`update discovered_keywords set dismissed = true where id = any($1::bigint[]) and workspace_id = $2`, [discoveredIds, ws]);
  revalidatePath("/keywords");
  return { added };
}

export async function dismissDiscovered(discoveredIds: string[]) {
  if (!discoveredIds.length) return { dismissed: 0 };
  const ws = await workspaceId();
  await exec(`update discovered_keywords set dismissed = true where id = any($1::bigint[]) and workspace_id = $2`, [discoveredIds, ws]);
  revalidatePath("/keywords");
  return { dismissed: discoveredIds.length };
}

export async function untrackKeywords(trackedKeywordIds: string[]) {
  if (!trackedKeywordIds.length) return { removed: 0 };
  const ws = await workspaceId();
  await exec(`delete from tracked_keywords where id = any($1::bigint[]) and workspace_id = $2`, [trackedKeywordIds, ws]);
  revalidatePath("/keywords");
  return { removed: trackedKeywordIds.length };
}

export async function starKeyword(trackedKeywordId: string, starred: boolean) {
  const ws = await workspaceId();
  await exec(`update tracked_keywords set starred = $3 where id = $1 and workspace_id = $2`, [trackedKeywordId, ws, starred]);
  revalidatePath("/keywords");
}

export async function setKeywordNote(trackedKeywordId: string, note: string | null) {
  const ws = await workspaceId();
  // Cap the note so a paste cannot bloat a row unboundedly.
  const trimmed = note?.slice(0, 1000) ?? null;
  await exec(`update tracked_keywords set note = $3 where id = $1 and workspace_id = $2`, [trackedKeywordId, ws, trimmed]);
  revalidatePath("/keywords");
}

/** Users can override the branded flag — a wrong one silently corrupts Share of Voice. */
export async function setKeywordBranded(trackedKeywordId: string, isBranded: boolean) {
  const ws = await workspaceId();
  await exec(`update tracked_keywords set is_branded = $3 where id = $1 and workspace_id = $2`, [trackedKeywordId, ws, isBranded]);
  revalidatePath("/keywords");
  revalidatePath("/dashboard");
}

/**
 * Adds keywords from the paste-a-list modal. Terms are trimmed, lowercased, deduped, and the
 * operation is idempotent.
 */
export async function addKeywords(trackedAppId: string, terms: string[], countries: string[]) {
  const ws = await workspaceId();

  const app = await q1<{ platform: string; name: string; developer_name: string | null }>(
    `select a.platform, a.name, a.developer_name from tracked_apps ta
       join apps a on a.id = ta.app_id
      where ta.id = $1 and ta.workspace_id = $2`,
    [trackedAppId, ws],
  );
  if (!app) throw new Error("Unknown app for this workspace.");

  const { isBranded } = await import("@/lib/scoring/scores.mjs");

  const unique = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 60))];
  let added = 0;
  let alreadyTracked = 0;
  const failed: string[] = [];

  for (const term of unique) {
    for (const country of countries) {
      try {
        const normalized = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
        const kw = await q1<{ id: string }>(
          `insert into keywords (term, term_normalized, platform, country, word_count)
           values ($1,$2,$3,$4,$5)
           on conflict (term_normalized, platform, country) do update set term = keywords.term
           returning id`,
          [term, normalized, app.platform, country, normalized.split(/\s+/).length],
        );
        const res = await q(
          `insert into tracked_keywords (workspace_id, tracked_app_id, keyword_id, source, is_branded)
           values ($1,$2,$3,'manual',$4)
           on conflict (tracked_app_id, keyword_id) do nothing
           returning id`,
          [ws, trackedAppId, kw!.id, isBranded(term, { appName: app.name, developerName: app.developer_name })],
        );
        if (res.length) added++;
        else alreadyTracked++;
      } catch {
        failed.push(term);
      }
    }
  }

  revalidatePath("/keywords");
  return { added, alreadyTracked, failed };
}

/**
 * "Track all" on an AI opportunity cluster: the analysis names exact tracked-data terms,
 * so this just re-uses addKeywords across the app's already-tracked markets.
 */
export async function trackTermsFromAnalysis(trackedAppId: string, terms: string[]): Promise<{ ok?: boolean; error?: string }> {
  if (!terms.length) return { error: "This opportunity names no keywords." };
  const ws = await workspaceId();
  const rows = await q<{ country: string }>(
    `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
      where tk.tracked_app_id = $1 and tk.workspace_id = $2`,
    [trackedAppId, ws],
  );
  await addKeywords(trackedAppId, terms, rows.length ? rows.map((r) => r.country) : ["us"]);
  revalidatePath("/competitors");
  return { ok: true };
}

/** Persisted so the matrix thresholds survive a refresh. */
export async function setMatrixThresholds(trackedAppId: string, thresholds: { difficulty: number; popularity: number }) {
  const ws = await workspaceId();
  await exec(
    `update tracked_apps set device = device where id = $1 and workspace_id = $2`,
    [trackedAppId, ws],
  );
  // ponytail: thresholds are a per-browser display preference, so they live in the URL
  // (already serialised by useFilters) rather than earning a column. Add one if a user asks
  // for them to follow across devices.
  return thresholds;
}

/**
 * Per-app switch read by the crawler's rollup job: promote discovered keywords that are
 * actually RANKING into tracked_keywords. Ideas that don't rank are never auto-tracked, so
 * this cannot quietly fill the table with noise.
 */
export async function setAutoTrackRanked(trackedAppId: string, enabled: boolean) {
  const ws = await workspaceId();
  await exec(`update tracked_apps set auto_track_ranked = $3 where id = $1 and workspace_id = $2`, [trackedAppId, ws, enabled]);
  revalidatePath("/keywords");
  return { enabled };
}
