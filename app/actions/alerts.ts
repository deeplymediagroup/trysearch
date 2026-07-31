"use server";

import { revalidatePath } from "next/cache";
import { exec, q1, currentWorkspace } from "@/lib/db";

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

/**
 * Upsert on (workspace, kind) so setting a rule twice updates rather than duplicating.
 * `threshold` stays NULLABLE on purpose: null means "use the default", which the UI shows
 * alongside the effective value. That distinction saves a lot of "why didn't I get an alert".
 */
export async function saveAlertSetting(kind: string, enabled: boolean, threshold: number | null = null) {
  const ws = await workspaceId();
  await exec(
    `insert into alert_settings (workspace_id, kind, enabled, threshold)
     values ($1,$2,$3,$4)
     on conflict (workspace_id, kind) do update set enabled = excluded.enabled, threshold = excluded.threshold`,
    [ws, kind, enabled, threshold],
  );
  revalidatePath("/alerts");
}

export async function setAlertEmail(email: string) {
  const ws = await workspaceId();
  const clean = email.trim();
  // Validate at the trust boundary rather than discovering it at send time.
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("That does not look like an email address.");
  await exec(`update users set alert_email = $2 where id = (select owner_id from workspaces where id = $1)`, [ws, clean || null]);
  revalidatePath("/alerts");
}

export async function pauseAlerts(paused: boolean) {
  const ws = await workspaceId();
  await exec(`update users set alerts_paused = $2 where id = (select owner_id from workspaces where id = $1)`, [ws, paused]);
  revalidatePath("/alerts");
}

export async function markAlertsRead() {
  const ws = await workspaceId();
  await exec(`update alerts set read_at = now() where workspace_id = $1 and read_at is null`, [ws]);
  revalidatePath("/alerts");
}
