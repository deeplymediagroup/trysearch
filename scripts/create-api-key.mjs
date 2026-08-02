#!/usr/bin/env node
/**
 * Mint an API key for /api/v1 and /mcp. The token is printed ONCE; only its SHA-256
 * hash is stored (api_keys.token_hash).
 *
 *   node scripts/create-api-key.mjs "claude-code"                 # read-only (default)
 *   node scripts/create-api-key.mjs "claude-code" --scope write   # may also mutate
 *
 * Read is the default deliberately: a read key cannot untrack an app or a keyword no matter
 * what it is asked to do, so handing one to an agent is a safe default.
 */
import { randomBytes, createHash } from "node:crypto";
import { connect, q1 } from "../lib/db.mjs";

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--")) ?? "default";
const scopeIdx = argv.indexOf("--scope");
const scope = scopeIdx === -1 ? "read" : argv[scopeIdx + 1];
if (!["read", "write"].includes(scope)) {
  console.error(`--scope must be "read" or "write" (got "${scope}").`);
  process.exit(1);
}

const token = `ts_${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");

const client = await connect();
try {
  const ws = await q1(client, `select id from workspaces order by created_at limit 1`);
  if (!ws) throw new Error("No workspace — run `npm run db:migrate` first.");

  await q1(
    client,
    `insert into api_keys (workspace_id, name, token_hash, prefix, scope) values ($1,$2,$3,$4,$5) returning id`,
    [ws.id, name, hash, token.slice(0, 8), scope],
  );

  console.log(`API key "${name}" created. Shown once — store it now:\n`);
  console.log(`  ${token}\n`);
  console.log(`Use it:`);
  console.log(`  curl -H "Authorization: Bearer ${token}" https://<host>/api/v1/apps`);
  console.log(`  claude mcp add --transport http trysearch https://<host>/mcp --header "Authorization: Bearer ${token}"`);
  if (scope === "read") console.log(`
This key cannot modify anything. Re-run with --scope write if it needs to.`);
} finally {
  await client.end();
}
