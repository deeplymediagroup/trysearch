/**
 * Bootstraps .env.local for trysearch by lifting the Neon endpoint from a sibling project
 * that already has one, then pointing it at the `trysearch` database.
 *
 * Never prints a secret value — only which variables it set.
 * Safe to re-run: it never overwrites a variable that already has a value.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd(), "..");
const SOURCES = ["idea-command-center/.env.local", "meta-ads-dashboard/.env.local"];
const OUT = path.join(process.cwd(), ".env.local");
const DB_NAME = "trysearch";

function readVar(file, key) {
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}\\s*=\\s*["']?([^"'\\n\\r]+)`, "m"));
  return m ? m[1].trim() : null;
}

let neonUrl = null;
for (const rel of SOURCES) {
  neonUrl = readVar(path.join(ROOT, rel), "DATABASE_URL");
  if (neonUrl) { console.log(`Found a Neon endpoint in ${rel}`); break; }
}
if (!neonUrl) {
  console.error("No DATABASE_URL found in any sibling project. Add one to .env.local by hand.");
  process.exit(1);
}

const u = new URL(neonUrl);
u.pathname = `/${DB_NAME}`;

const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
const has = (k) => new RegExp(`^${k}\\s*=\\s*\\S`, "m").test(existing);

const wanted = {
  DATABASE_URL: u.toString(),
  ADMIN_DATABASE_URL: neonUrl,
  // Mode A auth: one shared password. Random default so the gate is never accidentally open.
  CONSOLE_PASSWORD: "trysearch" + crypto.randomBytes(3).toString("hex"),
  // 32 bytes, base64 — encrypts store_credentials.payload_encrypted at rest.
  CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  RESEND_API_KEY: "",
  ANTHROPIC_API_KEY: "",
};

const lines = [];
const added = [];
for (const [k, v] of Object.entries(wanted)) {
  if (has(k)) continue;
  lines.push(`${k}=${v}`);
  added.push(k);
}

if (!lines.length) {
  console.log(".env.local already has every variable — nothing changed.");
} else {
  const header = existing ? existing.replace(/\s*$/, "\n") : "# trysearch.app — local secrets. Never committed.\n";
  fs.writeFileSync(OUT, header + lines.join("\n") + "\n");
  console.log(`Wrote ${added.length} variable(s) to .env.local: ${added.join(", ")}`);
  console.log("(values not printed)");
}
