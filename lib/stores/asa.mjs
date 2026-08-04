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

async function asaPost(path, body) {
  const token = await asaAccessToken();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-AP-Context": `orgId=${process.env.ASA_ORG_ID ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ASA POST ${path} ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Real Apple search popularity via the Impression Share custom report — the ONLY public
 * endpoint where Apple states a term's popularity. It comes back as a 1–5 bucket ("searchPopularity"),
 * coarser than the console's 5–100 but genuinely Apple-reported.
 *
 * SOV reports only filter by countryOrRegion and adamId (the numeric App Store id), and
 * return EVERY search term Apple associates with that app — one report covers the whole
 * keyword set. Quota: 10 custom reports per 24h, so callers make one call per (app, country)
 * per run, never one per keyword. Reports are async: create, poll, download.
 *
 * @returns {Promise<Map<string, number>>} term → 1..5 popularity bucket
 */
export async function searchPopularity({ adamId, country = "US", timeoutMs = 120000 }) {
  const out = new Map();
  if (!adamId || !asaConfigured()) return out;

  // Impression-share data lags ~2 days and the window must be within the last 30 days.
  const end = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);

  const created = await asaPost("/custom-reports", {
    name: `trysearch-sap-${Date.now()}`,
    startTime: start,
    endTime: end,
    granularity: "DAILY",
    selector: {
      conditions: [
        { field: "countryOrRegion", operator: "IN", values: [String(country).toUpperCase()] },
        { field: "adamId", operator: "IN", values: [String(adamId)] },
      ],
    },
  });
  const reportId = created?.data?.id;
  if (!reportId) throw new Error("ASA custom report: no report id returned.");

  // Poll until COMPLETED, then download the CSV.
  const deadline = Date.now() + timeoutMs;
  let downloadUri = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await asaGet(`/custom-reports/${reportId}`);
    const state = status?.data?.state;
    if (state === "COMPLETED") {
      downloadUri = status?.data?.downloadUri;
      break;
    }
    if (state === "FAILED") throw new Error("ASA custom report failed server-side.");
  }
  if (!downloadUri) throw new Error(`ASA custom report ${reportId} not ready within ${timeoutMs / 1000}s — it stays retrievable, next run picks it up.`);

  const csv = await (await fetch(downloadUri)).text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return out;
  const headers = splitCsvRow(lines[0]).map((h) => h.trim().toLowerCase());
  const termIdx = headers.findIndex((h) => h.includes("search") && h.includes("term"));
  const sapIdx = headers.findIndex((h) => h.includes("popularity"));
  if (termIdx < 0 || sapIdx < 0) return out;
  for (const line of lines.slice(1)) {
    const cells = splitCsvRow(line);
    const term = String(cells[termIdx] ?? "").toLowerCase().trim();
    const sap = Number(cells[sapIdx]);
    // Multiple daily rows per term — keep the highest bucket seen in the window.
    if (term && Number.isFinite(sap) && sap >= 1 && sap <= 5) out.set(term, Math.max(out.get(term) ?? 0, sap));
  }
  return out;
}

/** Minimal CSV row splitter honouring double quotes. */
function splitCsvRow(line) {
  const cells = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * Bucket → the 5–100 scale the popularity column speaks. These are bucket midpoints, chosen
 * once and documented: the value is Apple-reported, the placement within the bucket is ours.
 */
export const SAP_BUCKET_TO_POPULARITY = { 1: 5, 2: 25, 3: 45, 4: 65, 5: 85 };
