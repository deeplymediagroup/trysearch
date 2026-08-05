/**
 * Database access for the standalone scripts (crawler, smoke, migrate).
 *
 * Separate from lib/db.ts because the crawler must run as a plain `node scripts/crawl.mjs`
 * from Brandon's laptop with no build step — that is what keeps the "run it locally if
 * GitHub Actions minutes run out" fallback real.
 */
import { Client } from "pg";
import { loadEnv } from "../scripts/env.mjs";

export async function connect() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Run `node scripts/init-env.mjs`.");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

/** Rows helper mirroring lib/db.ts, so query strings can be copied between the two. */
export async function q(client, sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows;
}

export async function q1(client, sql, params = []) {
  const rows = await q(client, sql, params);
  return rows[0] ?? null;
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Upserts an app into the global catalogue and returns its uuid. */
export async function upsertApp(client, app) {
  const row = await q1(
    client,
    `insert into apps (platform, store_id, bundle_id, name, developer_name, developer_id,
                       icon_url, primary_genre, genres, price_cents, currency, content_rating,
                       version, released_at, version_released_at, is_free, has_iap, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     on conflict (platform, store_id) do update set
       -- coalesce so a partial source (a SERP row) never blanks a field a richer source filled
       bundle_id           = coalesce(excluded.bundle_id, apps.bundle_id),
       -- A "(app 123)" placeholder is a stand-in for a name we could not resolve, never a
       -- name: it must not overwrite a real one, and a real one must always replace it.
       name                = case
                               when excluded.name like '(app %' then apps.name
                               else coalesce(excluded.name, apps.name)
                             end,
       developer_name      = coalesce(excluded.developer_name, apps.developer_name),
       developer_id        = coalesce(excluded.developer_id, apps.developer_id),
       icon_url            = coalesce(excluded.icon_url, apps.icon_url),
       primary_genre       = coalesce(excluded.primary_genre, apps.primary_genre),
       genres              = coalesce(excluded.genres, apps.genres),
       price_cents         = coalesce(excluded.price_cents, apps.price_cents),
       currency            = coalesce(excluded.currency, apps.currency),
       content_rating      = coalesce(excluded.content_rating, apps.content_rating),
       version             = coalesce(excluded.version, apps.version),
       released_at         = coalesce(excluded.released_at, apps.released_at),
       version_released_at = coalesce(excluded.version_released_at, apps.version_released_at),
       is_free             = coalesce(excluded.is_free, apps.is_free),
       has_iap             = coalesce(excluded.has_iap, apps.has_iap),
       updated_at          = now()
     returning id`,
    [
      app.platform,
      String(app.store_id),
      app.bundle_id ?? null,
      app.name ?? `(app ${app.store_id})`,
      app.developer_name ?? null,
      app.developer_id ?? null,
      app.icon_url ?? null,
      app.primary_genre ?? null,
      app.genres?.length ? app.genres : null,
      app.price_cents ?? null,
      app.currency ?? null,
      app.content_rating ?? null,
      app.version ?? null,
      isoOrNull(app.released_at),
      isoOrNull(app.version_released_at),
      app.is_free ?? null,
      app.has_iap ?? null,
    ],
  );
  return row.id;
}

/** Upserts a keyword and returns {id, ...}. */
export async function upsertKeyword(client, { term, platform, country, language = null }) {
  const normalized = String(term).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 1;
  return q1(
    client,
    `insert into keywords (term, term_normalized, platform, country, language, word_count)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (term_normalized, platform, country) do update set term = keywords.term
     returning id, term, platform, country, popularity, popularity_source, popularity_estimate,
               difficulty, difficulty_parts, serp_depth, metrics_updated_at`,
    [term, normalized, platform, country, language, wordCount],
  );
}

function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
