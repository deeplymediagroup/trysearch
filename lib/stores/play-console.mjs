/**
 * Play Console GCS bucket client — the only free source of REAL search terms
 * (02-DATA-SOURCES.md §7). Measured queries with conversion data, not autocomplete inference.
 *
 * Three verified gotchas from the spec, all honored here:
 *   1. Auth does NOT go through Cloud IAM (§7.1) — the bucket is Google-owned. The service
 *      account needs zero project roles; access comes from Play Console's user list, and
 *      propagation can take 24h (do not debug 403s before then).
 *   2. Never construct the bucket name (§7) — it comes from Play Console → Download reports →
 *      "Copy Cloud Storage URI", via the PLAY_GCS_BUCKET env var.
 *   3. Reports are UTF-16 WITH a BOM (§7.4) — decode by reading the BOM, or the first header
 *      becomes "﻿Date" and parsers "lose" the Date column.
 *
 * No @google-cloud/storage dependency: a service-account JWT signed with node:crypto and two
 * REST calls cover list + download.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Service-account key from either PLAY_SERVICE_ACCOUNT_JSON (inline, how Actions passes
 * secrets) or PLAY_SERVICE_ACCOUNT_FILE (a path, for local runs).
 */
export function loadServiceAccount(file = process.env.PLAY_SERVICE_ACCOUNT_FILE) {
  try {
    if (process.env.PLAY_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
    if (file) return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* fall through */
  }
  return null;
}

/** OAuth token from a service-account key — RS256 JWT grant, no SDK. */
export async function serviceAccountToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.access_token;
}

/** GCS JSON API list — `bucket()`, never `list_buckets()`: the bucket is not in our project. */
export async function listReportObjects(token, bucket, prefix) {
  const out = [];
  let pageToken = null;
  do {
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o` +
      `?prefix=${encodeURIComponent(prefix)}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GCS list ${res.status} for ${prefix} — if this is a 403 within 24h of inviting the service account, wait (02 §7.1).`);
    const json = await res.json();
    out.push(...(json.items ?? []).map((i) => i.name));
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);
  return out;
}

export async function downloadObject(token, bucket, name) {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GCS download ${res.status} for ${name}`);
  return Buffer.from(await res.arrayBuffer());
}

/** UTF-16 with BOM detection — the `utf-16` codec the spec demands, hand-rolled for Node. */
export function decodeUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Big-endian: swap byte pairs, then decode LE.
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  const start = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0; // strip LE BOM
  return buf.subarray(start).toString("utf16le");
}

/** Minimal RFC-4180 CSV parse — report fields can contain quoted commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Parses one store_performance traffic_source CSV into search-term rows.
 * Columns (verified against 02 §7.3): Date, Package Name, Traffic Source, Search Term,
 * UTM Source, UTM Campaign, Store Listing Visitors, Store Listing Acquisitions,
 * Store Listing Conversion Rate. Only Search-traffic rows with a term survive; Google
 * collapses low-volume terms into a single "Other" row, kept and labeled as such.
 */
export function parseSearchTerms(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iDate = col("date");
  const iPkg = col("package name");
  const iSource = col("traffic source");
  const iTerm = col("search term");
  const iVisitors = col("store listing visitors");
  const iAcq = col("store listing acquisitions");
  const iCvr = col("store listing conversion rate");
  // Verify-don't-assume (02 §7.3): a missing Date column means the encoding or the layout
  // changed — refuse to guess.
  if (iDate === -1 || iPkg === -1 || iTerm === -1) {
    throw new Error(`store_performance header unexpected: [${rows[0].join(" | ")}]`);
  }

  const out = [];
  for (const r of rows.slice(1)) {
    const source = (r[iSource] ?? "").trim().toLowerCase();
    const term = (r[iTerm] ?? "").trim();
    if (!term || !source.includes("search")) continue;
    const num = (v) => {
      const n = Number(String(v ?? "").replace(/[%,]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      day: r[iDate].trim(),
      package_name: r[iPkg].trim(),
      search_term: term,
      visitors: num(r[iVisitors]),
      acquisitions: num(r[iAcq]),
      conversion_rate: num(r[iCvr]),
    });
  }
  return out;
}
