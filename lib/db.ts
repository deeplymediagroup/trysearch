/**
 * One Postgres interface for the whole app. Raw SQL, no ORM.
 *
 * All writes come from the Next.js server using DATABASE_URL; the browser never sees the
 * connection string, so the connection string IS the access control and no row-level
 * security is needed (04-DATABASE-SCHEMA.sql header).
 *
 * ponytail: no query builder, no repository layer. One operator, one database.
 */
import { Pool } from "pg";

export type Row = Record<string, any>;

declare global {
  // eslint-disable-next-line no-var
  var __trysearch_pool: Pool | undefined;
}

function pool(): Pool {
  if (!global.__trysearch_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — run `node scripts/init-env.mjs`.");
    global.__trysearch_pool = new Pool({
      // Strip sslmode/channel_binding from the URL: we set `ssl` explicitly below, and leaving
      // them in makes pg-connection-string emit a deprecation warning on every cold start that
      // buries real errors in the dev log.
      connectionString: url.replace(/[?&](sslmode|channel_binding)=[^&]*/g, (m) => (m[0] === "?" ? "?" : "")).replace(/\?&/, "?").replace(/\?$/, ""),
      ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
      // Many short-lived serverless instances share Neon's pooler, so keep each
      // instance's own pool small and let idle connections go rather than pinning them.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return global.__trysearch_pool;
}

/** Rows for a query. Parameterised always — never interpolate user input into SQL. */
export async function q<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool().query(sql, params);
  return res.rows as T[];
}

/** First row, or null. */
export async function q1<T = Row>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/** For statements whose rows we don't care about. */
export async function exec(sql: string, params: any[] = []): Promise<void> {
  await pool().query(sql, params);
}

/** Has the schema been applied? Drives the setup empty state instead of a crash. */
export async function schemaReady(): Promise<boolean> {
  try {
    const r = await q1<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
       where table_schema = 'public'
         and table_name in ('apps','keywords','rankings','tracked_apps','tracked_keywords')`,
    );
    return Number(r?.n ?? 0) >= 5;
  } catch {
    return false;
  }
}

/** The single workspace, for Mode A auth. Null when migrate has not run. */
export async function currentWorkspace(): Promise<{ id: string; name: string; owner_id: string } | null> {
  try {
    return await q1(`select id, name, owner_id from workspaces order by created_at limit 1`);
  } catch {
    return null;
  }
}
