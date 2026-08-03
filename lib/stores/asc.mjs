/**
 * App Store Connect API client — 02-DATA-SOURCES.md §5. Ported from Brandon's working
 * clients (mindset-dashboard/lib/appstore.ts for the JWT + Sales Reports, aso-revenue's
 * scripts/asc-analytics.mjs for the Analytics 4-hop flow) rather than written fresh.
 *
 * Two independent data sources, both first-party and free:
 *   - Sales Reports    -> downloads, re-downloads, IAP units, proceeds  (needs a VENDOR number)
 *   - Analytics Reports -> impressions / page views / downloads by source (needs only the app id)
 * Sales Reports require a vendor number that isn't obtainable via this API (it's under
 * Payments and Financial Reports in the ASC web UI), so this module degrades that half
 * gracefully — same "missing credential, never throw" rule as the crawler's other jobs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

const API = "https://api.appstoreconnect.apple.com/v1";

export function ascConfigured() {
  return Boolean(process.env.ASC_ISSUER_ID && process.env.ASC_KEY_ID && ascPrivateKey());
}

export function ascVendorConfigured() {
  return Boolean(process.env.ASC_VENDOR_NUMBER);
}

function ascPrivateKey() {
  // Vercel env vars can't hold a real file, so ASC_PRIVATE_KEY (raw PEM content) is the prod
  // path; ASC_PRIVATE_KEY_FILE (a local .p8 path) is the dev-machine convenience.
  if (process.env.ASC_PRIVATE_KEY) return process.env.ASC_PRIVATE_KEY;
  if (process.env.ASC_PRIVATE_KEY_FILE && fs.existsSync(process.env.ASC_PRIVATE_KEY_FILE)) {
    return fs.readFileSync(process.env.ASC_PRIVATE_KEY_FILE, "utf8");
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let cached = null;

/**
 * ES256 JWT. Apple caps the token lifetime at 20 minutes for analytics endpoints (02 §5.1) —
 * this mints one good for 15 and reuses it across the whole sync run rather than per call.
 */
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 30) return cached.token;

  const issuerId = process.env.ASC_ISSUER_ID;
  const keyId = process.env.ASC_KEY_ID;
  const privateKey = ascPrivateKey();
  if (!issuerId || !keyId || !privateKey) throw new Error("ASC credentials are not configured.");

  const exp = now + 15 * 60;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp, aud: "appstoreconnect-v1" }));
  const signingInput = `${header}.${payload}`;
  // Node's sign() on an EC key returns DER; ES256 JWTs want the raw 64-byte r||s form.
  // Getting this wrong is a confusing 401 with no hint that the encoding is the problem.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const token = `${signingInput}.${b64url(signature)}`;
  cached = { token, expiresAt: exp };
  return token;
}

async function ascGet(pathOrUrl, { presigned = false } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  // Segment URLs are pre-signed by Apple — sending an Authorization header on those can 400.
  const headers = presigned ? {} : { Authorization: `Bearer ${jwt()}` };
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ASC ${res.status} on ${pathOrUrl}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function ascJson(path) {
  const res = await ascGet(path);
  return res ? res.json() : null;
}

async function ascPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ASC POST ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Cheap credential probe: is this key valid, and does it see this app? */
export async function ascVerify(appId) {
  const data = await ascJson(`/apps/${appId}`);
  if (!data?.data) throw new Error(`No App Store Connect app with id ${appId} visible to this key.`);
  return { name: data.data.attributes?.name, bundleId: data.data.attributes?.bundleId };
}

/**
 * Registers the recurring ONGOING analytics request if one doesn't already exist. Idempotent
 * and safe to call every sync — the first request lands 24-48h later, which is expected, not
 * a failure (02 §5.5).
 */
async function ensureAnalyticsRequest(appId) {
  const existing = await ascJson(`/apps/${appId}/analyticsReportRequests?limit=50`);
  const rows = existing?.data ?? [];
  const ongoing = rows.find((r) => r.attributes?.accessType === "ONGOING");
  if (ongoing) {
    if (ongoing.attributes?.stoppedDueToInactivity) {
      // Apple kills a request that nobody has fetched from in a while (02 §5.5) — re-register.
      await ascPost("/analyticsReportRequests", {
        data: {
          type: "analyticsReportRequests",
          attributes: { accessType: "ONGOING" },
          relationships: { app: { data: { type: "apps", id: String(appId) } } },
        },
      });
      return { justRegistered: true };
    }
    return { justRegistered: false };
  }
  await ascPost("/analyticsReportRequests", {
    data: {
      type: "analyticsReportRequests",
      attributes: { accessType: "ONGOING" },
      relationships: { app: { data: { type: "apps", id: String(appId) } } },
    },
  });
  return { justRegistered: true };
}

function parseTsvGz(buffer) {
  const text = zlib.gunzipSync(buffer).toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/**
 * Pulls whatever "App Store Discovery and Engagement" segments are ready and returns raw TSV
 * rows. Column names are read by NAME (02 §5.5: Apple reserves the right to reorder them).
 */
export async function fetchEngagementRows(appId) {
  const { justRegistered } = await ensureAnalyticsRequest(appId);
  if (justRegistered) return { rows: [], note: "Analytics request just registered — first report lands in 24-48h." };

  const requests = await ascJson(`/apps/${appId}/analyticsReportRequests?limit=50`);
  const rows = [];
  let newestProcessingDate = null;

  for (const request of requests?.data ?? []) {
    const reports = await ascJson(`/analyticsReportRequests/${request.id}/reports?limit=200`);
    for (const report of reports?.data ?? []) {
      const name = report.attributes?.name ?? "";
      if (!name.toLowerCase().includes("discovery and engagement")) continue;

      const instances = await ascJson(`/analyticsReports/${report.id}/instances?filter[granularity]=DAILY&limit=50`);
      for (const instance of instances?.data ?? []) {
        const processingDate = instance.attributes?.processingDate;
        if (newestProcessingDate == null || processingDate > newestProcessingDate) newestProcessingDate = processingDate;

        const segments = await ascJson(`/analyticsReportInstances/${instance.id}/segments?limit=50`);
        // An instance can have multiple segments — download ALL of them or the data is
        // silently partial (02 §5.2).
        for (const segment of segments?.data ?? []) {
          const url = segment.attributes?.url;
          if (!url) continue;
          const res = await ascGet(url, { presigned: true });
          if (!res) continue;
          rows.push(...parseTsvGz(Buffer.from(await res.arrayBuffer())));
        }
      }
    }
  }
  return { rows, note: rows.length ? null : "No analytics instances ready yet." };
}

/**
 * Aggregates engagement TSV rows into per-(date, country) impression/page-view/download
 * counts, split by Source Type. Rows under ~5 users are dropped by Apple and never appear
 * here at all — that's Apple's privacy floor, not a bug in this aggregation.
 */
export function aggregateEngagement(rows, appId) {
  const byKey = new Map();
  for (const r of rows) {
    if (String(r["App Apple Identifier"]).trim() !== String(appId)) continue;
    const date = r["Date"];
    const country = (r["Territory"] || "ALL").trim();
    if (!date) continue;
    const key = `${date}|${country}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        date,
        country,
        impressions: 0,
        product_page_views: 0,
        impressions_search: 0,
        impressions_browse: 0,
        impressions_app_referrer: 0,
        impressions_web_referrer: 0,
      });
    }
    const bucket = byKey.get(key);
    const counts = Number(r["Counts"] ?? 0) || 0;
    const event = (r["Event"] || "").trim();
    const source = (r["Source Type"] || "").trim();

    if (event === "Impression") {
      bucket.impressions += counts;
      if (source === "App Store search") bucket.impressions_search += counts;
      else if (source === "App Store browse") bucket.impressions_browse += counts;
      else if (source === "App referrer") bucket.impressions_app_referrer += counts;
      else if (source === "Web referrer") bucket.impressions_web_referrer += counts;
    } else if (event === "Page view") {
      bucket.product_page_views += counts;
    }
  }
  return [...byKey.values()];
}

/**
 * Sales Reports (downloads, re-downloads, IAP units, proceeds) — needs ASC_VENDOR_NUMBER,
 * which this API cannot supply; it lives under Payments and Financial Reports in the ASC web
 * UI. Returns null (not an error) when the vendor number is absent, matching the crawler's
 * "missing credential degrades" rule.
 */
export async function fetchSalesReportTsv(reportDate) {
  const vendorNumber = process.env.ASC_VENDOR_NUMBER;
  if (!vendorNumber) return null;

  const qs = new URLSearchParams({
    "filter[frequency]": "DAILY",
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": vendorNumber,
    "filter[reportDate]": reportDate,
  });
  const res = await fetch(`${API}/salesReports?${qs}`, {
    headers: { Authorization: `Bearer ${jwt()}`, Accept: "application/a-gzip" },
  });
  if (res.status === 404) return null; // no report generated for that day yet
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ASC salesReports ${res.status} on ${reportDate}: ${body.slice(0, 300)}`);
  }
  return zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
}

/**
 * Sums the rows belonging to one app out of a whole-vendor daily Sales Report TSV.
 *
 * Product Type Identifier legend, verified against a real vendor file rather than assumed:
 *   1 / 1F / 1E / F1  = App download (first-time)
 *   7 / 7F            = App UPDATE — an existing owner updating, not a download of any kind.
 *                        A first pass here mislabelled this as "redownload" and produced a
 *                        23,075-unit spike on a release day that was actually update traffic.
 *   3 / 3F, IA*        = In-app purchase / subscription event.
 * The basic Sales/Trends SUMMARY report does not split "redownload by an existing owner" out
 * from "first-time download" the way App Store Connect Analytics does — so downloads_redownload
 * stays null (unmeasured), never a guessed number built from the wrong code.
 */
function emptyTotals() {
  return { downloads_first_time: 0, downloads_redownload: null, iap_units: 0, proceeds_usd: 0 };
}

function addRow(totals, row, iUnits, iProceeds, iType) {
  const units = Number(row[iUnits] ?? 0) || 0;
  const pt = (row[iType] ?? "").trim();
  totals.proceeds_usd += Number(row[iProceeds] ?? 0) || 0;
  if (pt === "1" || pt === "1F" || pt === "1E" || pt === "F1") totals.downloads_first_time += units;
  else if (pt === "7" || pt === "7F") return; // updates — not a metric this table tracks
  else totals.iap_units += units; // 3 / 3F / IA* and anything else that isn't a plain download
}

/**
 * Sums a whole-vendor daily Sales Report TSV for one app, both worldwide and per storefront —
 * the TSV carries a "Country Code" column, so the per-country breakdown costs nothing extra
 * once the file is already downloaded and parsed.
 */
export function parseSalesReport(tsv, appId) {
  const lines = tsv.split("\n").filter(Boolean);
  const worldwide = emptyTotals();
  const perCountry = new Map();
  if (lines.length < 2) return { worldwide, perCountry };

  const header = lines[0].split("\t");
  const idx = (name) => header.indexOf(name);
  const iUnits = idx("Units"), iProceeds = idx("Developer Proceeds"), iAppleId = idx("Apple Identifier"),
        iType = idx("Product Type Identifier"), iCountry = idx("Country Code");
  if (iUnits === -1 || iAppleId === -1 || iType === -1) return { worldwide, perCountry };

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split("\t");
    if (row[iAppleId] !== String(appId)) continue;
    addRow(worldwide, row, iUnits, iProceeds, iType);

    if (iCountry !== -1) {
      const cc = (row[iCountry] ?? "").trim().toLowerCase();
      if (cc) {
        if (!perCountry.has(cc)) perCountry.set(cc, emptyTotals());
        addRow(perCountry.get(cc), row, iUnits, iProceeds, iType);
      }
    }
  }
  return { worldwide, perCountry };
}
