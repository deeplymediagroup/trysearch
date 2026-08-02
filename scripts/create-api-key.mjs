#!/usr/bin/env node
/**
 * Mint an API key for /api/v1 and /mcp. The token is printed ONCE; only its SHA-256
 * hash is stored (api_keys.token_hash).
 *
 *   node scripts/create-api-key.mjs "claude-code"
 */
import { randomBytes, createHash } from "node:crypto";
import { connect, q1 } from "../lib/db.mjs";

const name = process.argv[2] ?? "default";
const token = `ts_${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");

const client = await connect();
try {
  const ws = await q1(client, `select id from workspaces order by created_at limit 1`);
  if (!ws) throw new Error("No workspace — run `npm run db:migrate` first.");

  await q1(
    client,
    `insert into api_keys (workspace_id, name, token_hash, prefix) values ($1,$2,$3,$4) returning id`,
    [ws.id, name, hash, token.slice(0, 8)],
  );

  console.log(`API key "${name}" created. Shown once — store it now:\n`);
  console.log(`  ${token}\n`);
  console.log(`Use it:`);
  console.log(`  curl -H "Authorization: Bearer ${token}" https://<host>/api/v1/apps`);
  console.log(`  claude mcp add --transport http trysearch https://<host>/mcp --header "Authorization: Bearer ${token}"`);
} finally {
  await client.end();
}
