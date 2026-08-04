"use server";

/**
 * Screenshot Studio server actions. Same rules as keywords.ts: every write re-validates
 * that the workspace owns the target row before touching it.
 *
 * Slides are stored one row per (set, position) with locale = 'base'; per-locale text
 * overrides live inside config.locales, so the canvas is the single source of truth.
 */
import { revalidatePath } from "next/cache";
import { q, q1, exec, currentWorkspace } from "@/lib/db";

// ponytail: same 3-entry map lives in components/ScreenshotStudio.tsx — extract to a
// shared module if a fourth device shows up.
const DEVICES: Record<string, { width: number; height: number }> = {
  'iPhone 6.9"': { width: 1320, height: 2868 },
  'iPhone 6.5"': { width: 1284, height: 2778 },
  'iPad 13"': { width: 2064, height: 2752 },
};

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

/** Ownership check: the join to tracked_apps on workspace_id IS the check. */
async function ownSet(setId: string, ws: string) {
  return q1<{ id: string; name: string; width_px: number; height_px: number; platform: string }>(
    `select s.id, s.name, s.width_px, s.height_px, s.platform
       from screenshot_sets s
       join tracked_apps ta on ta.id = s.tracked_app_id
      where s.id = $1 and ta.workspace_id = $2`,
    [setId, ws],
  );
}

export async function createSet(trackedAppId: string, name: string, device: string): Promise<{ id?: string; error?: string }> {
  const ws = await workspaceId();
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) return { error: "Name the set first." };
  const dims = DEVICES[device];
  if (!dims) return { error: `Unknown device "${device}".` };

  const app = await q1<{ platform: string }>(
    `select a.platform from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.id = $1 and ta.workspace_id = $2`,
    [trackedAppId, ws],
  );
  if (!app) return { error: "Unknown app for this workspace." };

  const row = await q1<{ id: string }>(
    `insert into screenshot_sets (tracked_app_id, name, platform, device_label, width_px, height_px)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [trackedAppId, trimmed, app.platform, device, dims.width, dims.height],
  );
  revalidatePath("/screenshots");
  return { id: row!.id };
}

export async function renameSet(setId: string, name: string): Promise<{ ok?: boolean; error?: string }> {
  const ws = await workspaceId();
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) return { error: "A set needs a name." };
  if (!(await ownSet(setId, ws))) return { error: "Unknown set for this workspace." };
  await exec(`update screenshot_sets set name = $2, updated_at = now() where id = $1`, [setId, trimmed]);
  revalidatePath("/screenshots");
  return { ok: true };
}

export async function deleteSet(setId: string): Promise<{ ok?: boolean; error?: string }> {
  const ws = await workspaceId();
  if (!(await ownSet(setId, ws))) return { error: "Unknown set for this workspace." };
  await exec(`delete from screenshot_sets where id = $1`, [setId]); // slides cascade
  revalidatePath("/screenshots");
  return { ok: true };
}

/**
 * Upserts the slide at a position. config is the whole slide document (background, text,
 * image data-URL, per-locale overrides); the headline/subhead columns are denormalised
 * copies of the base text so plain SQL can read what a slide says.
 */
export async function saveSlide(setId: string, position: number, config: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
  const ws = await workspaceId();
  if (!(await ownSet(setId, ws))) return { error: "Unknown set for this workspace." };
  if (!Number.isInteger(position) || position < 1 || position > 10) return { error: "Position must be 1–10." };
  if (config == null || typeof config !== "object") return { error: "Bad slide config." };

  const json = JSON.stringify(config);
  // The screenshot ships inside config as a data URL; cap the row so one upload can't bloat the table.
  if (json.length > 8_000_000) return { error: "Slide is too large — use a smaller screenshot image." };

  const headline = typeof (config.headline as { content?: unknown })?.content === "string" ? String((config.headline as { content: string }).content).slice(0, 200) : null;
  const subhead = typeof (config.subtext as { content?: unknown })?.content === "string" ? String((config.subtext as { content: string }).content).slice(0, 200) : null;

  await exec(
    `insert into screenshot_slides (set_id, locale, position, headline, subhead, config)
     values ($1,'base',$2,$3,$4,$5::jsonb)
     on conflict (set_id, locale, position)
       do update set headline = excluded.headline, subhead = excluded.subhead, config = excluded.config`,
    [setId, position, headline, subhead, json],
  );
  await exec(`update screenshot_sets set updated_at = now() where id = $1`, [setId]);
  revalidatePath("/screenshots");
  return { ok: true };
}

export async function deleteSlide(setId: string, position: number): Promise<{ ok?: boolean; error?: string }> {
  const ws = await workspaceId();
  if (!(await ownSet(setId, ws))) return { error: "Unknown set for this workspace." };
  // ponytail: no reindexing — positions may have gaps, the UI orders by position.
  await exec(`delete from screenshot_slides where set_id = $1 and position = $2`, [setId, position]);
  revalidatePath("/screenshots");
  return { ok: true };
}

/** Copies a set and all its slides, optionally onto another device size. */
export async function duplicateSet(setId: string, device?: string): Promise<{ id?: string; error?: string }> {
  const ws = await workspaceId();
  const src = await ownSet(setId, ws);
  if (!src) return { error: "Unknown set for this workspace." };

  let label: string | null = null;
  let dims: { width: number; height: number } | null = null;
  if (device) {
    dims = DEVICES[device] ?? null;
    if (!dims) return { error: `Unknown device "${device}".` };
    label = device;
  }

  const row = await q1<{ id: string }>(
    `insert into screenshot_sets (tracked_app_id, name, platform, device_label, width_px, height_px, template)
     select tracked_app_id, $2, platform, coalesce($3, device_label), coalesce($4, width_px), coalesce($5, height_px), template
       from screenshot_sets where id = $1
     returning id`,
    [setId, `${src.name} copy`.slice(0, 120), label, dims?.width ?? null, dims?.height ?? null],
  );
  await exec(
    `insert into screenshot_slides (set_id, locale, position, headline, subhead, image_url, config)
     select $2, locale, position, headline, subhead, image_url, config from screenshot_slides where set_id = $1`,
    [setId, row!.id],
  );
  revalidatePath("/screenshots");
  return { id: row!.id };
}
