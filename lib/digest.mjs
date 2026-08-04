/**
 * The daily alert digest — ONE email per workspace per day, never one per alert.
 *
 * Sent via Resend (free tier: 3,000/month, so one digest per day is comfortable). If
 * RESEND_API_KEY is absent this renders the email and returns it WITHOUT sending, so the
 * crawler still completes and the HTML can be inspected. Missing credential = degraded
 * feature, never a failed run.
 */

/** Every line carries the store and country — a rank without a storefront is meaningless. */
export function renderDigest({ workspaceName, alerts, date }) {
  const byApp = new Map();
  for (const a of alerts) {
    const list = byApp.get(a.app_name) ?? [];
    list.push(a);
    byApp.set(a.app_name, list);
  }

  const sections = [...byApp.entries()]
    .map(([appName, list]) => {
      const items = list
        .map((a) => {
          const store = a.platform === "ios" ? "App Store" : a.platform === "android" ? "Google Play" : "";
          const where = store && a.country ? ` <span style="color:#71717a">(${store} · ${String(a.country).toUpperCase()})</span>` : "";
          return `<li style="margin:0 0 6px 0;line-height:1.45">${escapeHtml(stripWhere(a.message))}${where}</li>`;
        })
        .join("");
      return `<h3 style="margin:18px 0 6px;font-size:14px;color:#f4f4f5">${escapeHtml(appName)}</h3><ul style="margin:0;padding-left:18px;font-size:13px;color:#a1a1aa">${items}</ul>`;
    })
    .join("");

  const subject = `${alerts.length} ASO alert${alerts.length === 1 ? "" : "s"} — ${date}`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#121214;border:1px solid #26262b;border-radius:10px;padding:20px">
    <p style="margin:0 0 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">trysearch · ${escapeHtml(workspaceName)}</p>
    <h1 style="margin:0 0 4px;font-size:17px;color:#f4f4f5">${alerts.length} alert${alerts.length === 1 ? "" : "s"} on ${escapeHtml(date)}</h1>
    <p style="margin:0;font-size:12px;color:#71717a">Positive rank movement means the rank improved.</p>
    ${sections}
    <p style="margin:22px 0 0;padding-top:12px;border-top:1px solid #26262b;font-size:11px;color:#71717a">
      One digest per day. Turn individual alerts off, change the threshold, or pause emails on the Alerts page.
    </p>
  </div>
</body></html>`;

  const text = [...byApp.entries()]
    .map(([appName, list]) => `${appName}\n${list.map((a) => `  - ${a.message}`).join("\n")}`)
    .join("\n\n");

  return { subject, html, text };
}

/** The message already ends with "(App Store · CA)"; the HTML re-adds it styled. */
function stripWhere(message) {
  return String(message).replace(/\s*\((App Store|Google Play)\s*·\s*[A-Z]{2}\)\s*$/, "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Sends the digest. Returns {sent, skipped, reason} — never throws on a missing key.
 */
export async function sendDigest({ to, workspaceName, alerts, date }) {
  if (!alerts.length) return { sent: false, skipped: true, reason: "no alerts today" };
  const rendered = renderDigest({ workspaceName, alerts, date });

  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, skipped: true, reason: "RESEND_API_KEY is not set", ...rendered };
  if (!to) return { sent: false, skipped: true, reason: "no recipient address", ...rendered };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM || "trysearch <onboarding@resend.dev>",
        to: [to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    if (!res.ok) return { sent: false, skipped: false, reason: `Resend returned ${res.status}`, ...rendered };
    return { sent: true, skipped: false, ...rendered };
  } catch (err) {
    return { sent: false, skipped: false, reason: err.message, ...rendered };
  }
}

// ---------------------------------------------------------------------------
// Weekly report — "Your week in ASO" (Workstream K)
// ---------------------------------------------------------------------------

/** 🇺🇸-style emoji flag from a 2-letter country code — email-safe, no images. */
function countryFlag(cc) {
  const s = String(cc ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return "";
  return String.fromCodePoint(...[...s].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * One section per app, labeled by store (same grouping rules as the daily digest:
 * app → store → keywords, dedup upstream). Positive mover = rank improved.
 *
 * apps: [{ name, platform, visibility, visibility_prev,
 *          movers: [{ term, country, from_rank, to_rank, delta }],
 *          discoveries: { count, top: [term] } }]
 */
export function renderWeekly({ workspaceName, weekEnd, apps }) {
  const sections = apps
    .map((app) => {
      const store = app.platform === "ios" ? "App Store" : "Google Play";
      const vis =
        app.visibility != null && app.visibility_prev != null
          ? `<p style="margin:2px 0 8px;font-size:12px;color:#a1a1aa">Visibility ${Number(app.visibility).toFixed(1)} <span style="color:#71717a">(${app.visibility >= app.visibility_prev ? "+" : ""}${(app.visibility - app.visibility_prev).toFixed(1)} vs last week)</span></p>`
          : "";
      const movers = (app.movers ?? [])
        .map((m) => {
          const arrow = m.delta > 0 ? "▲" : "▼";
          const color = m.delta > 0 ? "#4ade80" : "#f87171";
          return `<li style="margin:0 0 5px;line-height:1.45">${countryFlag(m.country)} “${escapeHtml(m.term)}” <span style="color:${color}">${arrow} ${Math.abs(m.delta)}</span> <span style="color:#71717a">(#${m.from_rank ?? "—"} → #${m.to_rank ?? "—"})</span></li>`;
        })
        .join("");
      const disc =
        app.discoveries?.count
          ? `<p style="margin:8px 0 0;font-size:12px;color:#a1a1aa">${app.discoveries.count} new keyword discover${app.discoveries.count === 1 ? "y" : "ies"}${app.discoveries.top?.length ? ` — top: ${app.discoveries.top.map(escapeHtml).join(", ")}` : ""}</p>`
          : "";
      return `<h3 style="margin:18px 0 2px;font-size:14px;color:#f4f4f5">${escapeHtml(app.name)} <span style="font-weight:400;color:#71717a">· ${store}</span></h3>${vis}<ul style="margin:0;padding-left:18px;font-size:13px;color:#a1a1aa">${movers || '<li style="color:#71717a">No rank movement this week.</li>'}</ul>${disc}`;
    })
    .join("");

  const subject = `Your week in ASO — ${weekEnd}`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#121214;border:1px solid #26262b;border-radius:10px;padding:20px">
    <p style="margin:0 0 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">trysearch · ${escapeHtml(workspaceName)}</p>
    <h1 style="margin:0 0 4px;font-size:17px;color:#f4f4f5">Your week in ASO</h1>
    <p style="margin:0;font-size:12px;color:#71717a">Week ending ${escapeHtml(weekEnd)}. Positive movement means the rank improved.</p>
    ${sections}
    <p style="margin:22px 0 0;padding-top:12px;border-top:1px solid #26262b;font-size:11px;color:#71717a">
      One summary per week, on Mondays. Daily alert digests are configured on the Alerts page.
    </p>
  </div>
</body></html>`;

  const text = apps
    .map((app) => {
      const movers = (app.movers ?? []).map((m) => `  ${m.delta > 0 ? "+" : ""}${m.delta} "${m.term}" (${String(m.country).toUpperCase()}) #${m.from_rank ?? "—"} -> #${m.to_rank ?? "—"}`).join("\n");
      return `${app.name} (${app.platform})\n${movers || "  no movement"}`;
    })
    .join("\n\n");

  return { subject, html, text };
}

/** Sends the weekly report. Same degrade rules as sendDigest — never throws on a missing key. */
export async function sendWeekly({ to, workspaceName, weekEnd, apps }) {
  if (!apps.length) return { sent: false, skipped: true, reason: "no apps to report on" };
  const rendered = renderWeekly({ workspaceName, weekEnd, apps });

  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, skipped: true, reason: "RESEND_API_KEY is not set", ...rendered };
  if (!to) return { sent: false, skipped: true, reason: "no recipient address", ...rendered };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM || "trysearch <onboarding@resend.dev>",
        to: [to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    if (!res.ok) return { sent: false, skipped: false, reason: `Resend returned ${res.status}`, ...rendered };
    return { sent: true, skipped: false, ...rendered };
  } catch (err) {
    return { sent: false, skipped: false, reason: err.message, ...rendered };
  }
}
