/**
 * Apple Search Ads — the seam for REAL Apple Search Popularity (5–100).
 *
 * Honest status: Apple shows Search Popularity in the ASA console's keyword planner, but the
 * public Campaign Management API (v5) does not publish it. This module implements the full
 * OAuth2 client-credentials flow (ES256 client-secret JWT) so the moment credentials exist we
 * can call authenticated endpoints, and exposes searchPopularity() as the single seam the
 * metrics job consults. Until Apple exposes SAP on a public endpoint (or a console-session
 * strategy is deliberately chosen), it returns null per term and popularity stays the labelled
 * proxy — modelled is labelled, never faked (house rule #2).
 *
 * Env: ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID, ASA_PRIVATE_KEY (PEM) or ASA_PRIVATE_KEY_FILE, ASA_ORG_ID.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
const API = "https://api.searchads.apple.com/api/v5";

export function asaConfigured() {
  return Boolean(process.env.ASA_CLIENT_ID && process.env.ASA_TEAM_ID && process.env.ASA_KEY_ID && asaPrivateKey());
}

function asaPrivateKey() {
  if (process.env.ASA_PRIVATE_KEY) return process.env.ASA_PRIVATE_KEY;
  if (process.env.ASA_PRIVATE_KEY_FILE && fs.existsSync(process.env.ASA_PRIVATE_KEY_FILE)) {
    return fs.readFileSync(process.env.ASA_PRIVATE_KEY_FILE, "utf8");
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let cachedToken = null;

/** ES256 client-secret JWT → OAuth2 access token, cached until near expiry. */
export async function asaAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const clientId = process.env.ASA_CLIENT_ID;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: process.env.ASA_KEY_ID }));
  const payload = b64url(
    JSON.stringify({ sub: clientId, aud: "https://appleid.apple.com", iss: process.env.ASA_TEAM_ID, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: asaPrivateKey(), dsaEncoding: "ieee-p1363" });
  const clientSecret = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "searchadsorg",
    }),
  });
  if (!res.ok) throw new Error(`ASA token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return cachedToken.token;
}

export async function asaGet(path) {
  const token = await asaAccessToken();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-AP-Context": `orgId=${process.env.ASA_ORG_ID ?? ""}` },
  });
  if (!res.ok) throw new Error(`ASA ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * The seam the metrics job consults: real Apple Search Popularity per term, or null.
 *
 * ponytail: returns nulls today — the public v5 API has no SAP endpoint. The auth stack above
 * is live and verified so the day a source exists this is a one-function change; callers
 * already handle null by keeping popularity_source = 'proxy'.
 *
 * @returns {Promise<Map<string, number|null>>}
 */
export async function searchPopularity(terms /* , countryCode = "US" */) {
  const out = new Map();
  for (const t of terms) out.set(t, null);
  return out;
}
