/**
 * Applies db/schema.sql. No ORM, no migration table — the schema is idempotent
 * (`create table if not exists`, `create or replace view`) so re-running it is the
 * migration mechanism. Gate 0 requires this to run clean twice in a row.
 *
 * Also seeds exactly one users row and one workspaces row for Mode A (single-password)
 * auth, per 08-AUTH-AND-DEPLOY.md §1.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { loadEnv } from "./env.mjs";

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run `node scripts/init-env.mjs` first.");
  process.exit(1);
}

const schemaPath = path.join(process.cwd(), "db", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

const SEED_EMAIL = process.env.SEED_EMAIL || "deeplymediagroup@gmail.com";

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  const t0 = Date.now();

  await client.query(schema);

  // Seed the single tenant. `plan='self'` marks it as Brandon's own install rather than
  // a customer account. Both inserts are conditional so re-running changes nothing.
  await client.query(
    `insert into users (email, name, plan)
     select $1, 'Brandon', 'self'
     where not exists (select 1 from users)`,
    [SEED_EMAIL],
  );
  await client.query(
    `insert into workspaces (owner_id, name)
     select u.id, 'Mindset'
     from users u
     where not exists (select 1 from workspaces)
     limit 1`,
  );
  await client.query(
    `insert into workspace_members (workspace_id, user_id, role)
     select w.id, w.owner_id, 'owner' from workspaces w
     on conflict (workspace_id, user_id) do nothing`,
  );

  const counts = await client.query(`
    select
      (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
      (select count(*) from pg_indexes where schemaname='public')                                              as indexes,
      (select count(*) from information_schema.views where table_schema='public')                              as views,
      (select count(*) from users)                                                                              as users,
      (select count(*) from workspaces)                                                                         as workspaces
  `);
  const c = counts.rows[0];
  console.log(
    `Migrated in ${Date.now() - t0}ms — ${c.tables} tables, ${c.indexes} indexes, ${c.views} view(s); ` +
    `${c.users} user, ${c.workspaces} workspace.`,
  );
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  if (err.position) console.error(`  at character ${err.position} of db/schema.sql`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
