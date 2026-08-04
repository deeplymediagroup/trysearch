/**
 * Trends — market-wide keyword niche watch (US iOS).
 *
 * Plain .mjs, runnable under node with no build step, same rule as the crawler.
 * Gathers the last 14 days of discovered + autocomplete terms, asks ONE aiJson
 * call to cluster them into named niches, then computes momentum in code —
 * the AI names things, it never invents numbers.
 *
 * Degrades, never blocks the nightly run: no API key → {skipped}, AI failure →
 * warn + {skipped}. Rows land in trend_niches (DDL: db/migrations-trends.sql).
 */
import { tokens, normalizeTerm } from "./scoring/text.mjs";

const DAY_MS = 24 * 3600 * 1000;
const MAX_TERMS = 300;
const MAX_NICHES = 12;

/**
 * Momentum = share of member terms first seen in the last 7 days vs the prior 7.
 * Pure, exported separately so the vitest suite covers it without a DB.
 *
 * @param {(Date|string)[]} firstSeenDates
 * @param {Date} [now]
 * @returns {number} 0-100 (0 when nothing falls in the 14-day window)
 */
export function momentumScore(firstSeenDates, now = new Date()) {
  const t = now.getTime();
  let recent = 0;
  let prior = 0;
  for (const d of firstSeenDates ?? []) {
    const ms = new Date(d).getTime();
    if (Number.isNaN(ms)) continue;
    const age = t - ms;
    if (age <= 7 * DAY_MS) recent++; // includes slight clock skew into the future
    else if (age <= 14 * DAY_MS) prior++;
    // older than 14 days: outside the window, ignored
  }
  const total = recent + prior;
  if (total === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((recent / total) * 100)));
}

/** Junk filter: too short, numeric-only, or nothing left after stopword removal. */
function isJunk(term) {
  const n = normalizeTerm(term);
  if (!n || n.length < 3) return true;
  if (/^\d+$/.test(n)) return true;
  if (tokens(n).size === 0) return true; // stopwords/punctuation only
  return false;
}

/**
 * @param {{ sql: (text: string, params?: any[]) => Promise<any[]>,
 *           aiJson: Function, aiEnabled: () => boolean }} deps
 *   `sql` is a plain (text, params) => rows function; scripts/trends-job.mjs
 *   builds it from lib/db.mjs's q(client, ...).
 */
export async function computeTrends({ sql, aiJson, aiEnabled }) {
  if (!aiEnabled()) return { skipped: "no api key" };

  // -- gather ---------------------------------------------------------------
  // First-seen is min() over ALL history with a HAVING on the window, so a
  // term that resurfaced this week but was first seen a month ago is excluded.
  const discovered = await sql(
    `select k.term, min(dk.discovered_at) as first_seen, max(dk.relevance) as relevance
       from discovered_keywords dk
       join keywords k on k.id = dk.keyword_id
      where k.platform = 'ios' and k.country = 'us' and dk.dismissed = false
      group by k.term
     having min(dk.discovered_at) > now() - interval '14 days'`,
  );
  const autocomplete = await sql(
    `select term_normalized as term, min(observed_at) as first_seen
       from autocomplete_hits
      where platform = 'ios' and country = 'us'
      group by term_normalized
     having min(observed_at) > now() - interval '14 days'`,
  );

  // Brand-only exclusion: a term that IS an app's name (or its pre-separator
  // head) is demand for that app, not a niche.
  // ponytail: exact-name match only; token-level brand detection if this leaks.
  const appNames = await sql(`select distinct name from apps where platform = 'ios'`);
  const branded = new Set();
  for (const { name } of appNames) {
    const full = normalizeTerm(name);
    if (full) branded.add(full);
    const head = normalizeTerm(String(name).split(/[:\-–—|]/)[0]);
    if (head && head.length >= 4) branded.add(head);
  }

  // Merge on the normalized term: earliest first_seen wins, keep any relevance score.
  const byTerm = new Map();
  for (const row of [...discovered, ...autocomplete]) {
    const term = normalizeTerm(row.term);
    if (isJunk(term) || branded.has(term)) continue;
    if (row.relevance != null && row.relevance < 40) continue;
    const prev = byTerm.get(term);
    const firstSeen = new Date(row.first_seen);
    if (!prev) byTerm.set(term, { term, firstSeen, relevance: row.relevance ?? null });
    else {
      if (firstSeen < prev.firstSeen) prev.firstSeen = firstSeen;
      if (row.relevance != null) prev.relevance = Math.max(prev.relevance ?? 0, row.relevance);
    }
  }

  const all = [...byTerm.values()];
  if (!all.length) return { skipped: "no terms in the last 14 days" };

  // Highest-relevance, newest-first slice for the single AI call.
  const forAi = [...all]
    .sort((a, b) => (b.relevance ?? 50) - (a.relevance ?? 50) || b.firstSeen - a.firstSeen)
    .slice(0, MAX_TERMS);

  // -- one AI call: cluster into named niches --------------------------------
  let niches;
  try {
    const result = await aiJson({
      system:
        "You are an App Store market analyst. Cluster the given search terms into named demand niches — groups of terms pointing at the same emerging user need. Rules: at most 12 niches; a niche needs at least 3 member terms; member_terms must be copied verbatim from the input list; why_now is under 20 words explaining why this niche is moving now; skip terms that fit nowhere. Do not invent terms.",
      prompt: `SEARCH TERMS (US iOS, first seen in the last 14 days):\n${forAi.map((t) => t.term).join("\n")}`,
      schema: {
        type: "object",
        properties: {
          niches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                why_now: { type: "string" },
                member_terms: { type: "array", items: { type: "string" } },
              },
              required: ["name", "why_now", "member_terms"],
              additionalProperties: false,
            },
          },
        },
        required: ["niches"],
        additionalProperties: false,
      },
    });
    niches = result.niches;
  } catch (err) {
    console.warn(`[trends] AI clustering failed, skipping this run: ${err.message}`);
    return { skipped: `ai failed: ${err.message}` };
  }

  const now = new Date();
  const cleaned = (niches ?? [])
    .map((n) => ({
      name: String(n.name ?? "").trim(),
      why_now: String(n.why_now ?? "").split(/\s+/).slice(0, 20).join(" "),
      // Keep only terms we actually sent — momentum stays grounded in measured dates.
      member_terms: [...new Set((n.member_terms ?? []).map(normalizeTerm))].filter((t) => byTerm.has(t)),
    }))
    .filter((n) => n.name && n.member_terms.length >= 2)
    .slice(0, MAX_NICHES)
    .map((n) => ({
      ...n,
      momentum: momentumScore(n.member_terms.map((t) => byTerm.get(t).firstSeen), now),
    }));

  // -- rising keywords: brand-new this week, scored relevant, not branded ----
  const rising = all
    .filter((t) => now - t.firstSeen <= 7 * DAY_MS && (t.relevance ?? 0) >= 60)
    .sort((a, b) => b.relevance - a.relevance || b.firstSeen - a.firstSeen)
    .slice(0, 50)
    .map((t) => ({ term: t.term, relevance: t.relevance, first_seen: t.firstSeen.toISOString() }));

  // -- persist: one row per niche + one '__rising__' meta row, shared computed_at
  for (const n of cleaned) {
    await sql(
      `insert into trend_niches (computed_at, name, why_now, momentum, member_terms)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [now, n.name, n.why_now, n.momentum, JSON.stringify(n.member_terms)],
    );
  }
  await sql(
    `insert into trend_niches (computed_at, name, rising) values ($1, '__rising__', $2::jsonb)`,
    [now, JSON.stringify(rising)],
  );

  return { computed_at: now.toISOString(), terms: all.length, sent_to_ai: forAi.length, niches: cleaned.length, rising: rising.length };
}
