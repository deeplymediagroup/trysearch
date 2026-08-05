/**
 * Per-competitor keyword scan (Workstream E2), shared by the add-competitor action
 * (immediate footprint) and the nightly crawler (weekly refresh).
 *
 * Two passes per competitor:
 *   1. LISTING — extractive, free: Android's indexed description via extractListingKeywords,
 *      iOS's indexed name+subtitle bigrams. Source 'competitor'.
 *   2. AI — generateCompetitorKeywords (brand queries + derivatives), each candidate gated by
 *      live autocomplete before insertion. Source 'competitor_ai'. Skipped when AI is off.
 *
 * Takes `query(sql, params) => rows[]` like lib/serp.mjs, so both runtimes can call it.
 */
import { appleAppSSR, appleAutocomplete } from "./stores/apple.mjs";
import { playAppDetail, playSuggest, extractListingKeywords } from "./stores/play.mjs";
import { aiEnabled, generateCompetitorKeywords, verifyCandidate } from "./ai.mjs";

// Stopwords break a phrase into runs rather than being dropped in place: dropping them in
// place invents adjacency ("sleep and tools" → "sleep tools"), keeping them ships junk
// ("and tools", "and workout"). Nobody searches a stopword-edged phrase.
const BIGRAM_STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with", "from",
  "my", "your", "our", "its", "it", "is", "are", "be", "was", "as", "that", "this", "you",
  "we", "us", "all", "any", "not", "but", "so", "if", "can", "will", "just", "more", "than",
  // "app", "apps" and "free" stay OUT of this set — people really do search "motivation app"
  // and "free workout apps".
  "into", "out", "up", "down", "over", "per", "via",
]);

export function bigrams(text) {
  const out = [];
  for (const run of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).reduce((runs, w) => {
    if (w.length > 2 && !BIGRAM_STOP.has(w)) runs[runs.length - 1].push(w);
    else runs.push([]);
    return runs;
  }, [[]])) {
    out.push(...run);
    for (let i = 0; i < run.length - 1; i++) out.push(`${run[i]} ${run[i + 1]}`);
  }
  return out;
}

const norm = (t) => String(t ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Gate for anything about to become a discovered keyword, whatever the source. Kills the
 * "and", "and tools", "and workout" class: a phrase that starts or ends on a stopword is
 * never a real query, and neither is a bare filler word.
 */
export function isJunkTerm(term) {
  const w = norm(term).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!w.length) return true;
  if (BIGRAM_STOP.has(w[0]) || BIGRAM_STOP.has(w[w.length - 1])) return true;
  if (w.length === 1 && w[0].length < 3) return true;
  return false;
}

/**
 * @param query        (sql, params) => Promise<rows[]>
 * @param opts.workspaceId    workspace owning the discoveries
 * @param opts.ownTrackedAppId tracked_apps.id of the OWN app the competitor belongs to
 * @param opts.ownAppName     for the AI prompt's "don't generate my brand" context
 * @param opts.competitor     { platform, store_id, name }
 * @param opts.countries      storefronts to file discoveries under (verification uses the first)
 * @returns { listed, aiVerified } counts, for logs
 */
export async function scanCompetitor(query, { workspaceId, ownTrackedAppId, ownAppName = "", competitor, countries = ["us"] }) {
  // Fresh listing — the scan should reflect the competitor TODAY, not the last snapshot.
  let listing = null;
  if (competitor.platform === "ios") {
    const ssr = await appleAppSSR(competitor.store_id, countries[0]).catch(() => null);
    if (ssr) listing = { name: ssr.name, subtitle: ssr.subtitle, description: ssr.description };
  } else {
    const d = await playAppDetail(competitor.store_id, countries[0]).catch(() => null);
    if (d) listing = { name: d.name, subtitle: d.summary, description: d.description };
  }
  if (!listing) return { listed: 0, aiVerified: 0 };

  // Pass 1 — extractive listing terms.
  const candidates = new Map(); // normalized -> { term, source }
  const add = (terms, source) => {
    for (const t of terms) {
      const n = norm(t);
      if (n.length < 3 || n.length > 45) continue;
      if (!candidates.has(n)) candidates.set(n, { term: t, source });
    }
  };
  if (competitor.platform === "android") {
    add(extractListingKeywords(listing, { max: 25 }).map((k) => k.term), "competitor");
  } else {
    add(bigrams(`${listing.name ?? ""} ${listing.subtitle ?? ""}`), "competitor");
  }
  const listed = candidates.size;

  // Pass 2 — AI brand/derivative terms, autocomplete-verified.
  let aiVerified = 0;
  if (aiEnabled()) {
    const ideas = await generateCompetitorKeywords({ competitor: listing, ownAppName }).catch(() => []);
    for (const term of ideas) {
      try {
        const suggestions = competitor.platform === "ios"
          ? await appleAutocomplete(term, countries[0])
          : await playSuggest(term, countries[0]);
        if (verifyCandidate(term, suggestions)) {
          const n = norm(term);
          if (!candidates.has(n)) { candidates.set(n, { term, source: "competitor_ai" }); aiVerified++; }
        }
      } catch {
        /* one bad candidate must not abandon the rest */
      }
    }
  }

  // Insert as discoveries on the OWN app. Same shape the discovery job writes.
  for (const [normalized, { term, source }] of candidates) {
    for (const country of countries) {
      const [kw] = await query(
        `insert into keywords (term, term_normalized, platform, country, word_count)
         values ($1,$2,$3,$4,$5)
         on conflict (term_normalized, platform, country) do update set term = keywords.term
         returning id`,
        [term, normalized, competitor.platform, country, normalized.split(/\s+/).length],
      );
      const tracked = await query(
        `select 1 from tracked_keywords where tracked_app_id = $1 and keyword_id = $2`,
        [ownTrackedAppId, kw.id],
      );
      if (tracked.length) continue;
      await query(
        `insert into discovered_keywords (workspace_id, tracked_app_id, keyword_id, source)
         values ($1,$2,$3,$4)
         on conflict (tracked_app_id, keyword_id) do nothing`,
        [workspaceId, ownTrackedAppId, kw.id, source],
      );
    }
  }

  return { listed, aiVerified };
}
