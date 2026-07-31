/**
 * Adds a real app plus keywords to track. Used to set up Gate 3, and useful thereafter as the
 * command-line equivalent of the "+ Add app" / "+ Add Keywords" buttons.
 *
 * Usage:
 *   node scripts/seed-app.mjs --ios 1487761500 --countries us,gb --keywords "motivational quotes,daily motivation"
 *   node scripts/seed-app.mjs --ios 1487761500 --competitor 876080126
 *   node scripts/seed-app.mjs --android com.example.app --countries us
 */
import { connect, q, q1, upsertApp, upsertKeyword } from "../lib/db.mjs";
import { setFetchSink } from "../lib/stores/http.mjs";
import { appleLookup, appleAppSSR } from "../lib/stores/apple.mjs";
import { playAppDetail } from "../lib/stores/play.mjs";
import { isBranded } from "../lib/scoring/scores.mjs";

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const iosId = arg("--ios");
const androidId = arg("--android");
const competitorId = arg("--competitor");
const countries = (arg("--countries", "us") ?? "us").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
const keywords = (arg("--keywords", "") ?? "").split(",").map((k) => k.trim()).filter(Boolean);

if (!iosId && !androidId) {
  console.error("Pass --ios <trackId> or --android <package>.");
  process.exit(1);
}

const platform = iosId ? "ios" : "android";
const storeId = iosId ?? androidId;

const db = await connect();
setFetchSink(db);

const workspace = await q1(db, `select id, name from workspaces order by created_at limit 1`);
if (!workspace) { console.error("No workspace. Run `npm run db:migrate` first."); process.exit(1); }

/** Fetches real metadata so the catalogue row is never a placeholder. */
async function fetchApp(id) {
  if (platform === "ios") {
    const [meta] = await appleLookup([id], countries[0]);
    if (!meta) return null;
    const ssr = await appleAppSSR(id, countries[0]).catch(() => null);
    return { ...meta, subtitle: ssr?.subtitle ?? null };
  }
  const d = await playAppDetail(id, countries[0]);
  return d ? { ...d, has_iap: null } : null;
}

async function track(id, role, competitorOf = null) {
  const meta = await fetchApp(id);
  if (!meta) { console.error(`Could not fetch ${platform} app ${id} — check the id.`); process.exit(1); }

  const appId = await upsertApp(db, { ...meta, platform, store_id: id });
  const row = await q1(
    db,
    `insert into tracked_apps (workspace_id, app_id, role, competitor_of, device, is_active)
     values ($1,$2,$3,$4,$5,true)
     on conflict (workspace_id, app_id, competitor_of) do update set is_active = true
     returning id`,
    [workspace.id, appId, role, competitorOf, platform === "ios" ? "iphone" : "android_phone"],
  );

  console.log(`${role === "own" ? "Tracking" : "Competitor"}: ${meta.name}${meta.subtitle ? ` — “${meta.subtitle}”` : ""} (${platform} ${id})`);
  return { trackedAppId: row.id, appId, meta };
}

if (competitorId) {
  // Attach a competitor to the existing own app.
  const own = await q1(
    db,
    `select ta.id, a.store_id from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.workspace_id = $1 and ta.role = 'own' and a.platform = $2 and a.store_id = $3`,
    [workspace.id, platform, storeId],
  );
  if (!own) { console.error(`Track ${storeId} as your own app first.`); process.exit(1); }
  await track(competitorId, "competitor", own.id);
} else {
  const { trackedAppId, meta } = await track(storeId, "own");

  let added = 0;
  for (const term of keywords) {
    for (const country of countries) {
      const kw = await upsertKeyword(db, { term, platform, country });
      // Branded classification is conservative and user-overridable — a wrong flag silently
      // corrupts Share of Voice.
      const branded = isBranded(term, { appName: meta.name, developerName: meta.developer_name });
      const res = await db.query(
        `insert into tracked_keywords (workspace_id, tracked_app_id, keyword_id, source, is_branded)
         values ($1,$2,$3,'manual',$4)
         on conflict (tracked_app_id, keyword_id) do update set is_branded = excluded.is_branded
         returning (xmax = 0) as is_new`,
        [workspace.id, trackedAppId, kw.id, branded],
      );
      if (res.rows[0]?.is_new) added++;
    }
  }
  if (keywords.length) console.log(`${added} keyword(s) tracked across ${countries.join(", ")}.`);
}

await db.end();
