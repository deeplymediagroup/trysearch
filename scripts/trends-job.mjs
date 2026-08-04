/**
 * Standalone Trends runner — `node scripts/trends-job.mjs`.
 *
 * Same bootstrap as scripts/crawl.mjs: lib/db.mjs's connect() loads .env via
 * scripts/env.mjs and requires DATABASE_URL. Applies db/migrations-trends.sql
 * first (idempotent — scripts/migrate.mjs only applies schema.sql), then runs
 * computeTrends and prints a one-line summary. Wire into the nightly workflow
 * after the discovery/autocomplete jobs so it sees tonight's terms.
 */
import fs from "node:fs";
import path from "node:path";
import { connect, q } from "../lib/db.mjs";
import { aiJson, aiEnabled } from "../lib/ai.mjs";
import { computeTrends } from "../lib/trends.mjs";

const client = await connect();
try {
  const ddl = fs.readFileSync(path.join(process.cwd(), "db", "migrations-trends.sql"), "utf8");
  await client.query(ddl);

  const sql = (text, params = []) => q(client, text, params);
  const res = await computeTrends({ sql, aiJson, aiEnabled });

  if (res.skipped) console.log(`Trends skipped: ${res.skipped}`);
  else console.log(`Trends: ${res.niches} niche(s) from ${res.terms} term(s) (${res.sent_to_ai} sent to AI), ${res.rising} rising — run ${res.computed_at}`);
} finally {
  await client.end().catch(() => {});
}
