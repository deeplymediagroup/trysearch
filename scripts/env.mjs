/**
 * Hand-rolled .env parser — house convention across Brandon's projects: pull scripts
 * use node:fs + fetch only and never depend on dotenv.
 *
 * Reads .env.local then .env, first definition wins, and never overwrites a variable
 * that is already set in the real environment (so GitHub Actions secrets take priority).
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnv(dir = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip matching surrounding quotes, but leave inner ones alone
      if (val.length > 1 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
  return process.env;
}

/**
 * Collects missing-credential warnings instead of throwing. Standing convention:
 * a missing optional credential degrades one feature, it never kills the run.
 */
export function requireEnv(names, warnings = []) {
  const out = {};
  for (const n of names) {
    if (process.env[n]) out[n] = process.env[n];
    else warnings.push(`${n} is not set — the feature that needs it is skipped.`);
  }
  return out;
}
