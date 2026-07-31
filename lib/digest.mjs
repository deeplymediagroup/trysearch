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
