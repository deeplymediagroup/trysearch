/**
 * One-time: create the `trysearch` database inside Brandon's EXISTING Neon project.
 *
 * Neon's free tier caps on STORAGE, not on databases-per-project, so a new database in
 * the existing project costs nothing while a new project would burn the one free slot.
 *
 * Reads the admin connection string from ADMIN_DATABASE_URL (or DATABASE_URL) and swaps
 * the database name. CREATE DATABASE cannot run through the -pooler endpoint, so we strip
 * that too. Prints the resulting DATABASE_URL with the password masked — never in full.
 */
import { Client } from "pg";
import { loadEnv } from "./env.mjs";

loadEnv();

const TARGET = process.env.TRYSEARCH_DB_NAME || "trysearch";
const source = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;

if (!source) {
  console.error("No ADMIN_DATABASE_URL or DATABASE_URL set. Put an admin Neon URL in .env.local first.");
  process.exit(1);
}

const admin = new URL(source);
admin.host = admin.host.replace("-pooler", ""); // CREATE DATABASE needs the direct endpoint
const adminDbName = admin.pathname.replace(/^\//, "");
admin.pathname = "/neondb"; // any existing database will do as the entry point

const masked = (u) => {
  const c = new URL(u.toString());
  if (c.password) c.password = "***";
  return c.toString();
};

const client = new Client({ connectionString: admin.toString(), ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  const { rows } = await client.query("select datname from pg_database order by 1");
  const existing = rows.map((r) => r.datname);
  console.log(`Databases in this Neon project: ${existing.join(", ")}`);

  if (existing.includes(TARGET)) {
    console.log(`\n"${TARGET}" already exists — nothing to do.`);
  } else {
    // Identifier cannot be parameterised; TARGET is ours, but validate anyway.
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(TARGET)) throw new Error(`Refusing to create unsafe database name: ${TARGET}`);
    await client.query(`create database "${TARGET}"`);
    console.log(`\nCreated database "${TARGET}".`);
  }

  const appUrl = new URL(source);
  appUrl.pathname = `/${TARGET}`;
  console.log(`\nAdd this to .env.local (password shown masked here, real value written for you):`);
  console.log(`DATABASE_URL=${masked(appUrl)}`);
  console.log(`\n(entry database was "${adminDbName}"; the app URL keeps the -pooler endpoint)`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
