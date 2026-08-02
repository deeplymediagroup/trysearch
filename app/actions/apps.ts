"use server";

/**
 * App-level Server Actions — 05-API-ROUTES.md §1. These are what the Add App / Add Competitor
 * dialogs call, and they are the reason a teammate no longer needs a terminal.
 *
 * Every write re-validates that the workspace owns the target row, even though there is one
 * workspace today: the pattern has to be right before this ever becomes multi-tenant.
 */
import { revalidatePath } from "next/cache";
import { q, q1, exec, currentWorkspace } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { upsertApp } from "@/lib/db.mjs";
import { parseAppRef } from "@/lib/stores/resolve.mjs";
import { appleLookup, appleSearch, appleAppSSR } from "@/lib/stores/apple.mjs";
import { playAppDetail, playSearchRanked } from "@/lib/stores/play.mjs";

export type Candidate = {
  store: "ios" | "android";
  store_id: string;
  name: string;
  developer_name: string | null;
  icon_url: string | null;
  bundle_id: string | null;
  country: string;
};

/**
 * lib/db.mjs helpers take a node-postgres client. The pool behind lib/db.ts is the same
 * interface minus the shape, so this shim lets the Next app reuse upsertApp instead of
 * carrying a second copy of that 40-line upsert. Same trick as api-core's fetch sink.
 */
const dbShim = { query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) };

let sinkReady = false;
function withSink() {
  if (sinkReady) return;
  setFetchSink(dbShim);
  sinkReady = true;
}

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

const shape = (a: any, store: "ios" | "android", country: string): Candidate => ({
  store,
  store_id: String(a.store_id),
  name: a.name ?? `(app ${a.store_id})`,
  developer_name: a.developer_name ?? null,
  icon_url: a.icon_url ?? null,
  bundle_id: a.bundle_id ?? null,
  country,
});

/**
 * Paste anything: a store URL, a share link, a numeric iOS id, a bundle id / package name, or
 * an app name. Returns candidates for the user to pick from — never auto-tracks, because a
 * name search is a guess and tracking the wrong app is annoying to undo.
 */
export async function findApp(
  input: string,
  { store, country = "us" }: { store?: "ios" | "android" | null; country?: string } = {},
): Promise<{ candidates: Candidate[]; error?: string }> {
  const ref = parseAppRef(input);
  if (!ref) return { candidates: [] };

  withSink();
  // A country embedded in a pasted URL is better evidence than the picker's default.
  const cc = (ref.country ?? country ?? "us").toLowerCase();

  try {
    // Exact id → exactly one answer.
    if (ref.id) {
      if (ref.store === "ios") {
        const [app] = await appleLookup([ref.id], cc);
        return { candidates: app ? [shape(app, "ios", cc)] : [], error: app ? undefined : `No iOS app with id ${ref.id} in ${cc.toUpperCase()}.` };
      }
      const app = await playAppDetail(ref.id!, cc);
      return { candidates: app ? [shape(app, "android", cc)] : [], error: app ? undefined : `No Play app "${ref.id}" in ${cc.toUpperCase()}.` };
    }

    // A dotted token is a valid id on both stores, so ask both and let the answers decide.
    if (ref.bundle) {
      const [ios, android] = await Promise.all([
        store === "android" ? Promise.resolve([]) : appleLookup([ref.bundle], cc, { bundleId: true }).catch(() => []),
        store === "ios" ? Promise.resolve(null) : playAppDetail(ref.bundle, cc).catch(() => null),
      ]);
      const candidates = [
        ...(ios as any[]).map((a) => shape(a, "ios", cc)),
        ...(android ? [shape(android, "android", cc)] : []),
      ];
      return { candidates, error: candidates.length ? undefined : `"${ref.bundle}" is not a live app on either store in ${cc.toUpperCase()}.` };
    }

    // Name search. Search only the requested store when the dialog has one selected.
    const term = ref.query!;
    const [ios, android] = await Promise.all([
      store === "android" ? Promise.resolve([]) : appleSearch(term, cc, 8).catch(() => []),
      store === "ios" ? Promise.resolve([]) : playSearchRanked(term, cc).catch(() => []),
    ]);
    return {
      candidates: [
        ...(ios as any[]).slice(0, 8).map((a) => shape(a, "ios", cc)),
        ...(android as any[]).slice(0, 8).map((a) => shape(a, "android", cc)),
      ],
    };
  } catch (err: any) {
    return { candidates: [], error: err.message };
  }
}

/**
 * Tracks an app the user picked from findApp. `role: 'competitor'` needs `competitorOf`, the
 * tracked_apps id of one of OUR apps — that edge is what the whole competitive engine reads.
 */
export async function trackApp({
  store,
  storeId,
  country = "us",
  role = "own",
  competitorOf = null,
}: {
  store: "ios" | "android";
  storeId: string;
  country?: string;
  role?: "own" | "competitor";
  competitorOf?: string | null;
}) {
  const ws = await workspaceId();
  withSink();

  if (role === "competitor") {
    if (!competitorOf) throw new Error("A competitor has to be attached to one of your own apps.");
    // Ownership check: a foreign id simply matches nothing.
    const own = await q1(`select id from tracked_apps where id = $1 and workspace_id = $2 and role = 'own'`, [competitorOf, ws]);
    if (!own) throw new Error("Unknown app for this workspace.");
  }

  // Fetch real metadata so the catalogue row is never a placeholder (same rule as seed-app).
  let meta: any;
  if (store === "ios") {
    const [m] = await appleLookup([storeId], country);
    if (!m) throw new Error(`Could not fetch iOS app ${storeId} in ${country.toUpperCase()}.`);
    const ssr = await appleAppSSR(storeId, country).catch(() => null);
    meta = { ...m, subtitle: ssr?.subtitle ?? null };
  } else {
    meta = await playAppDetail(storeId, country);
    if (!meta) throw new Error(`Could not fetch Play app ${storeId} in ${country.toUpperCase()}.`);
  }

  const appId = await upsertApp(dbShim, { ...meta, platform: store, store_id: storeId });
  const row = await q1<{ id: string }>(
    `insert into tracked_apps (workspace_id, app_id, role, competitor_of, device, is_active)
     values ($1,$2,$3,$4,$5,true)
     on conflict (workspace_id, app_id, competitor_of) do update set is_active = true
     returning id`,
    [ws, appId, role, role === "competitor" ? competitorOf : null, store === "ios" ? "iphone" : "android_phone"],
  );

  revalidatePath("/", "layout"); // the app switcher lives in the shell, on every page
  return { tracked_app_id: row!.id, name: meta.name as string, platform: store };
}

/**
 * Untracks an app or a competitor, with full cleanup.
 *
 * The teardown is the schema's, not ours: tracked_keywords, discovered_keywords,
 * target_keywords, competitive_positions, annotations, listings and the app's own competitor
 * rows all reference tracked_apps with `on delete cascade`. Deleting one row removes the lot.
 * Rows in the shared catalogue (`apps`, `keywords`, `rankings`) survive on purpose — they are
 * global measurements another app may still be using.
 */
export async function untrackApp(trackedAppId: string) {
  const ws = await workspaceId();
  const row = await q1<{ id: string }>(`select id from tracked_apps where id = $1 and workspace_id = $2`, [trackedAppId, ws]);
  if (!row) throw new Error("Unknown app for this workspace.");

  await exec(`delete from tracked_apps where id = $1 and workspace_id = $2`, [trackedAppId, ws]);
  revalidatePath("/", "layout");
  return { removed: true };
}
