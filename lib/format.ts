/**
 * Every formatter in the product — 06-FRONTEND-SPEC.md §4.
 *
 * NOTHING ELSE IN THE CODEBASE FORMATS A NUMBER. That rule exists because "a 0 that should
 * have been an em dash" is the most likely bug in this entire build, and the one that destroys
 * user trust fastest. Centralising it means the rule is enforced in one place and tested once.
 */

export const EM_DASH = "—";
export const DOUBLE_DASH = "--";

/** The four-valued rank state (01 §2.1). These are genuinely different things. */
export type RankState = {
  rank: number | null;
  found: boolean;
  last_known_rank?: number | null;
  crawl_depth?: number | null;
  checked?: boolean;
};

/**
 * rank(r) → '#42' | 'Not ranked' | '>200' | '>200 (was #163)' | '—'
 *
 * - '#42'             currently ranked
 * - 'Not ranked'      checked, never seen ranked
 * - '>200'            was ranked, has now fallen out of the crawl depth
 * - '>200 (was #163)' same, and we remember where it was
 * - '—'               not yet checked at all
 */
export function rank(state: RankState | null | undefined): string {
  if (!state || state.checked === false) return EM_DASH;
  if (state.rank != null) return `#${state.rank}`;

  const depth = state.crawl_depth ?? null;
  const last = state.last_known_rank ?? null;

  if (last != null && depth != null) return `>${depth} (was #${last})`;
  if (last != null) return `Not ranked (was #${last})`;
  if (depth != null) return `>${depth}`;
  return "Not ranked";
}

/**
 * delta(d) → '+30' | '-64' | '0' | '—'
 *
 * null becomes an em dash and 0 stays '0'. They must NEVER be conflated: 0 means measured and
 * unchanged; the em dash means we have no comparison. Positive means the rank IMPROVED.
 */
export function delta(d: number | null | undefined): string {
  if (d == null) return EM_DASH;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : String(d);
}

/** Which of the four delta states this is, so the UI can style them distinguishably. */
export function deltaTone(d: number | null | undefined): "up" | "down" | "zero" | "none" {
  if (d == null) return "none";
  if (d === 0) return "zero";
  return d > 0 ? "up" : "down";
}

/** score(n) → '61' | '—' */
export function score(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return EM_DASH;
  return String(Math.round(Number(n)));
}

/**
 * popularity(p) → '54' | '5 (28)'
 *
 * The parenthesised number is OURS. Apple floors low-volume terms at a flat 5, so when the
 * store value is that floor we show both: the store's figure and our estimate. A legend on the
 * same screen must state that parentheses mean an estimate.
 */
export function popularity(kw: {
  popularity?: number | null;
  popularity_estimate?: number | null;
  popularity_source?: string | null;
} | null | undefined): string {
  if (!kw) return EM_DASH;
  const store = kw.popularity ?? null;
  const est = kw.popularity_estimate ?? null;

  if (store == null && est == null) return EM_DASH;
  if (store == null) return est == null ? EM_DASH : `(${est})`; // no store value at all: ours only
  if (est == null) return String(store);
  if (est === store) return String(store);
  return `${store} (${est})`;
}

/** True when the displayed popularity is (partly) modelled, so the UI can mark it. */
export function popularityIsEstimated(kw: {
  popularity?: number | null;
  popularity_estimate?: number | null;
} | null | undefined): boolean {
  if (!kw) return false;
  if (kw.popularity == null) return kw.popularity_estimate != null;
  return kw.popularity_estimate != null && kw.popularity_estimate !== kw.popularity;
}

/** percent(n) → '7.7%' */
export function percent(n: number | null | undefined, decimals = 1): string {
  if (n == null || Number.isNaN(Number(n))) return EM_DASH;
  return `${Number(n).toFixed(decimals)}%`;
}

/**
 * money(cents, currency) → '$271K/mo' | '<$5K/mo'
 * ALWAYS carries its currency, and currencies are never mixed in one arithmetic expression.
 */
export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return EM_DASH;
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const value = cents / 100;
  if (value >= 1_000_000) return `${symbol}${trim(value / 1_000_000)}M`;
  if (value >= 1000) return `${symbol}${Math.round(value / 1000)}K`;
  return `${symbol}${trim(value)}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CAD: "CA$", GBP: "£", EUR: "€", AUD: "A$", JPY: "¥" };

const trim = (n: number) => String(Math.round(n * 100) / 100);

/** count(n) → '266,912' */
export function count(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return EM_DASH;
  return Number(n).toLocaleString("en-US");
}

/**
 * relativeDate() → 'Today' | 'yesterday' | '2w ago' | '13h ago' | 'never'
 * `null` here genuinely means "never", not "unknown", which is why it differs from the em dash.
 */
export function relativeDate(value: Date | string | null | undefined, now: Date = new Date()): string {
  if (!value) return "never";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "never";

  const ms = now.getTime() - d.getTime();
  const days = Math.floor(ms / 86_400_000);

  if (days === 0) {
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) {
      const mins = Math.max(0, Math.floor(ms / 60_000));
      return mins <= 1 ? "just now" : `${mins}m ago`;
    }
    return `${hours}h ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Absolute short date for chart pins and activity rows: 'Jul 22', or 'Today'. */
export function shortDate(value: Date | string | null | undefined, now: Date = new Date()): string {
  if (!value) return EM_DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  if (d.toDateString() === now.toDateString()) return "Today";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** ISO date, for URLs and CSV export where a locale would be wrong. */
export function isoDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Star rating → '4.8' */
export function rating(n: number | null | undefined): string {
  if (n == null) return EM_DASH;
  return Number(n).toFixed(1);
}

/** gap(n) → '+7' | '-33' | '—'. Rendered with an explicit sign. */
export const gap = delta;

/** Store label. A rank without a store and country is meaningless. */
export function storeLabel(platform: string | null | undefined): string {
  if (platform === "ios") return "App Store";
  if (platform === "android") return "Google Play";
  return EM_DASH;
}

/** Install counts, where Android has an exact number and iOS has nothing. */
export function installs(n: number | null | undefined): string {
  if (n == null) return EM_DASH; // Apple exposes no install count at any price
  const v = Number(n);
  if (v >= 1_000_000_000) return `${trim(v / 1_000_000_000)}B`;
  if (v >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return count(v);
}

/** CSV cell escaping. Every table exports CSV, and keywords contain commas and quotes. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const head = cols.map(csvCell).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}

/** Public store listing for an app. Used wherever an app name or icon is clickable. */
export function storeUrl(platform: string, storeId: string | null | undefined, country = "us"): string | null {
  if (!storeId) return null;
  return platform === "android"
    ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(storeId)}&gl=${country.toUpperCase()}`
    : `https://apps.apple.com/${country.toLowerCase()}/app/id${encodeURIComponent(storeId)}`;
}
