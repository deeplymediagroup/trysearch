/**
 * Every score, exactly as specified in 03-ALGORITHMS.md.
 *
 * All functions here are PURE — inputs to a number, no I/O. That is not stylistic: it is what
 * lets the ⓘ popover in the UI show the very inputs that produced the number, which is the
 * product's main trust feature and is nearly free once the formulas are pure.
 *
 * TWO INVARIANTS THAT OVERRIDE ANY CONVENIENCE:
 *   1. Unmeasurable returns null, NEVER 0. `0` means "measured, and it's zero" (a trivially
 *      easy keyword); `null` means "we don't know". Conflating them sends users at
 *      impossible keywords, and it is the bug most likely to ship.
 *   2. Modelled ≠ measured. Anything estimated carries its provenance (popularity_source)
 *      so the UI can label it as an estimate.
 */
import { median, roundToSigFigs, titleMatch, wordCount } from "./text.mjs";

// ===========================================================================
// 1. Popularity (0-100) — how much a keyword is searched
// ===========================================================================

/**
 * The iOS demand proxy (§1.2), and the default path.
 *
 * Apple floors low-volume terms at a flat 5, and its Search Ads popularity metric COLLAPSED
 * between 2025-09-29 and 2025-10-03 (US keywords above 5 fell ~165,875 → ~39,254, a 77%
 * drop). So on the mid and long tail — exactly where a small app can win — every paid tool's
 * iOS "volume" number is a proxy too. This is the same class of thing, built from the free
 * autocomplete signal.
 *
 * Three signals, `reveal` weighted highest because it discriminates best: a term Apple starts
 * suggesting after 3 typed characters is in far higher demand than one that appears after 13.
 *
 * @param {{length: number|null, index: number|null, best: number|null, hits: number}} depth
 *   from suggestDepth() in lib/stores/apple.mjs
 * @returns {{value: number|null, parts: object}} null when the term never appeared at ANY
 *   prefix length — we did not observe it, which differs from observing that nobody searches it
 */
export function popularityProxy(depth) {
  const { length = null, index = null, best = null, hits = 0 } = depth ?? {};

  // Never suggested at any prefix → null, not 0.
  if (length == null && best == null) return { value: null, parts: null };

  const reveal = length == null ? 0 : (25 - length) / 24; // reveals at 1 char → 1.0
  const slot = index == null ? 0 : Math.max(0, (4 - index) / 4); // position within that list
  const position = best == null ? 0 : Math.max(0, (10 - best) / 10); // best position ever seen
  const breadth = Math.min(1, hits / 5); // how many distinct prefixes surfaced it

  const value = Math.round(100 * (0.5 * reveal + 0.2 * slot + 0.2 * position + 0.1 * breadth));

  return {
    value,
    parts: {
      reveal: Math.round(reveal * 100),
      slot: Math.round(slot * 100),
      position: Math.round(position * 100),
      breadth: Math.round(breadth * 100),
      revealed_at_char: length,
      revealed_at_position: index,
      prefixes_seen: hits,
    },
  };
}

/**
 * The Android demand proxy (§1.3).
 *
 * Google Play publishes no popularity metric at all, so every Android "volume" number in
 * every tool on the market is a model. But Play hands us something iOS never will: REAL
 * install counts. So the autocomplete signal is anchored to the install volume of the apps
 * actually ranking in the top 10.
 *
 * Android is the better-instrumented platform here, not the worse one.
 *
 * @param depth        from suggestDepth() driven by the IJ4APc Play-Store suggest
 * @param realInstalls top-10 realInstalls values (NOT the bucketed `installs` string —
 *                     "100,000,000+" vs 360,532,190 is a 3.6× loss of signal)
 */
export function popularityProxyAndroid(depth, realInstalls = []) {
  const auto = popularityProxy(depth);
  if (auto.value == null) return { value: null, parts: null };

  const med = median(realInstalls);
  // 100M installs → 100.
  const installScore = med == null ? null : Math.min(100, (100 * Math.log10(med + 1)) / 8);

  const value =
    installScore == null
      ? auto.value // no install data: fall back to autocomplete alone rather than inventing one
      : Math.round(0.7 * auto.value + 0.3 * installScore);

  return {
    value,
    parts: {
      ...auto.parts,
      auto_score: auto.value,
      install_score: installScore == null ? null : Math.round(installScore),
      median_real_installs: med,
    },
  };
}

/** popularity_estimate wins when present; the store's value (often a floored 5) is the fallback. */
export function popularityEffective(keyword) {
  return keyword?.popularity_estimate ?? keyword?.popularity ?? null;
}

// ===========================================================================
// 2. Difficulty (0-100) — how hard it is to rank near the top
// ===========================================================================

/**
 * Measured from the VISIBLE search results page, deliberately NOT derived from Apple's
 * popularity metric (see §1.4 — it collapsed).
 *
 * ⚠️ There is no `depth`/`resultCount` component here, and that removal is deliberate.
 * Brandon's existing aso.ts has one at weight 0.15, but live testing showed resultCount
 * saturates against the 200-row response cap: "game" returns 188 and "zen breathing timer
 * app" returns 178. Those differ by NOISE, not by real competition, so the component
 * contributed a near-constant ~15 points to every keyword — dead weight that compressed the
 * useful range. The remaining three weights are renormalised (0.45/0.30/0.10 → 0.53/0.35/0.12).
 *
 * Use MZStore results for the top-10 sample, never itunes /search: the two disagree (top-10
 * matches 8/10, top-50 overlap just 30/50) and MZStore is the true store ranking.
 *
 * @param {object}   input
 * @param {Array}    input.top   top-10 SERP rows: {name, rating_count, real_installs}
 * @param {string}   input.term
 * @param {number}   input.serpDepth  the TRUE number of results the store returned
 * @param {string}   input.platform
 * @returns {{value: number|null, parts: object|null}} null when the SERP was never fetched
 */
export function difficulty({ top, term, serpDepth = null, platform = "ios" } = {}) {
  // Never fetched → null. NOT 0, which reads as "easy".
  if (!Array.isArray(top) || top.length === 0) return { value: null, parts: null };

  // Social proof of the incumbents. iOS has no install counts at any price, so it falls back
  // to rating counts; Android uses the real number Play publishes.
  const strengths = top.map((a) => strengthOf(a, platform)).filter((n) => n != null);
  const med = median(strengths);
  if (med == null) return { value: null, parts: null };

  // 1k ratings ≈ 50, 100k ≈ 83, 1M = 100.
  const leaders = Math.min(100, (100 * Math.log10(med + 1)) / 6);

  // If the winners literally have the phrase in their name, the slot is being won on
  // exact-match relevance and is hard to take.
  const matches = top.filter((a) => titleMatch(a.name, term)).length;
  // Denominator is a fixed 10 per the spec, not the sample size: a SERP with only 3 results
  // genuinely IS less contested, and dividing by 3 would inflate it to look competitive.
  const titleMatchScore = (100 * matches) / 10;

  // Single words are hardest; long-tail phrases are easier.
  const specificity = Math.max(0, 100 - (Math.max(1, wordCount(term)) - 1) * 25);

  const value = Math.min(100, Math.round(0.53 * leaders + 0.35 * titleMatchScore + 0.12 * specificity));

  return {
    value,
    parts: {
      leaders: Math.round(leaders),
      titleMatch: Math.round(titleMatchScore),
      specificity: Math.round(specificity),
      // Kept SEPARATE and reported honestly: appsAnalyzed is the difficulty sample (top 10),
      // serpDepth is the true result count (which can be 188 or 250). Different numbers.
      appsAnalyzed: top.length,
      medianStrength: med,
      titleMatches: matches,
      serpDepth,
      strengthMetric: platform === "android" ? "real_installs" : "rating_count",
    },
  };
}

/** Social proof for the difficulty/outlier maths. */
function strengthOf(app, platform) {
  if (platform === "android") {
    const n = app?.real_installs ?? app?.install_count ?? app?.rating_count;
    return typeof n === "number" && n >= 0 ? n : null;
  }
  const n = app?.rating_count;
  return typeof n === "number" && n >= 0 ? n : null;
}

export const DIFFICULTY_LABELS = [
  [75, "Very hard"],
  [55, "Hard"],
  [35, "Moderate"],
  [0, "Winnable"],
];

export function difficultyLabel(d) {
  if (d == null) return "Unknown";
  for (const [floor, label] of DIFFICULTY_LABELS) if (d >= floor) return label;
  return "Winnable";
}

/** Display brackets, distinct from the labels above (§2). */
export function difficultyBracket(d) {
  if (d == null) return null;
  if (d < 30) return "low competition";
  if (d < 60) return "moderate";
  return "highly competitive";
}

/**
 * SERP outlier (§2.1) — an app holding a top-10 slot with at least 10× LESS social proof
 * than the SERP median.
 *
 * Meaning: it is out-ranking its own strength, which almost always means strong metadata.
 * That makes it the single best competitor to study, because it proves the keyword is
 * winnable WITHOUT size. So we store the evidence, not just the boolean.
 *
 * Null for SERPs with fewer than 3 results.
 */
export function serpOutlier({ top, platform = "ios" } = {}) {
  if (!Array.isArray(top) || top.length < 3) return { value: null, apps: [] };

  const strengths = top.map((a) => strengthOf(a, platform)).filter((n) => n != null);
  const med = median(strengths);
  if (med == null || med === 0) return { value: null, apps: [] };

  const apps = [];
  top.forEach((app, i) => {
    const strength = strengthOf(app, platform);
    if (strength == null) return;
    if (strength * 10 <= med) {
      apps.push({ position: i + 1, store_id: app.store_id ?? null, name: app.name ?? null, strength, median: med });
    }
  });

  return { value: apps.length > 0, apps };
}

/**
 * Beatable (§2.2) — "a top-3 slot looks winnable".
 *
 * Fires when EITHER condition holds:
 *   (a) someone in the top 3 holds it with 10× less strength than the median, or
 *   (b) the term is under-targeted in titles (≤2 of the top 10) AND the top 3 is weak.
 *
 * "weakTop3" is not defined numerically in the spec, so it is defined here explicitly and
 * conservatively: the median strength of the top 3 is no greater than the SERP median — i.e.
 * the leaders are not actually the strongest apps present.
 *
 * The badge is worthless without evidence, so weakSpotRank names WHICH position to go after.
 */
export function beatable({ top, term, platform = "ios" } = {}) {
  if (!Array.isArray(top) || top.length < 3) return { value: null, evidence: null };

  const strengths = top.map((a) => strengthOf(a, platform)).filter((n) => n != null);
  const med = median(strengths);
  if (med == null) return { value: null, evidence: null };

  const top3 = top.slice(0, 3);
  const soft = top3
    .map((app, i) => ({ position: i + 1, app, strength: strengthOf(app, platform) }))
    .filter((r) => r.strength != null && r.strength * 10 <= med);

  const matches = top.filter((a) => titleMatch(a.name, term)).length;
  const top3Median = median(top3.map((a) => strengthOf(a, platform)));
  const weakTop3 = top3Median != null && top3Median <= med;

  const byUnderTargeting = matches <= 2 && weakTop3;
  const value = soft.length > 0 || byUnderTargeting;

  // The soft slot to attack: an outlier if there is one, otherwise the weakest of the top 3.
  let weakSpotRank = soft[0]?.position ?? null;
  if (weakSpotRank == null && value) {
    let weakest = null;
    top3.forEach((app, i) => {
      const s = strengthOf(app, platform);
      if (s == null) return;
      if (!weakest || s < weakest.strength) weakest = { position: i + 1, strength: s };
    });
    weakSpotRank = weakest?.position ?? null;
  }

  return {
    value,
    evidence: {
      weakSpotRank,
      medianStrength: med,
      top3Median,
      titleMatches: matches,
      softSlots: soft.map((r) => ({ position: r.position, name: r.app.name ?? null, strength: r.strength })),
      reason: soft.length
        ? `the #${soft[0].position} app holds its slot with ${soft[0].strength.toLocaleString()} against a ${Math.round(med).toLocaleString()} median`
        : byUnderTargeting
          ? `only ${matches} of the top 10 have this keyword in their title, and the top 3 are no stronger than the field`
          : null,
    },
  };
}

// ===========================================================================
// 3. Gap
// ===========================================================================

/** Positive gap = more demand than competition = the sweet spot. Null if either side is null. */
export function gap(keyword) {
  const pop = popularityEffective(keyword);
  const diff = keyword?.difficulty;
  if (pop == null || diff == null) return null;
  return pop - diff;
}

// ===========================================================================
// 4. Opportunity (0-100)
// ===========================================================================

/**
 * Gap is a blunt subtraction; opportunity is the ranked recommendation.
 *
 * It starts from how easy the keyword is, weights by real demand, dampens low-volume terms
 * so a trivially-easy nothing-term cannot top the list, and boosts keywords where we are
 * CLOSE — ranking #4-#30 means a small push pays off, whereas #1 has nothing left to gain
 * and #500 is a fantasy.
 */
export function opportunity({ popularity, difficulty: diff, rank = null, relevance = null } = {}) {
  if (diff == null || popularity == null) return null;

  const ease = (100 - diff) / 100;
  const demand = popularity / 100;
  const demandWeighted = demand ** 1.5; // dampens low-popularity terms

  // A missing AI relevance score must not distort the ranking, so it defaults to neutral.
  const rel = relevance == null ? 0.5 : relevance / 100;

  return Math.round(100 * (0.4 * demandWeighted + 0.35 * rankUpside(rank) + 0.15 * ease + 0.1 * rel));
}

/** Where is the leverage? #11-30 is the highest-leverage zone — page 1 is in reach. */
export function rankUpside(rank) {
  if (rank == null) return 0.8; // unranked: full upside, unproven
  if (rank <= 3) return 0.1; // already won
  if (rank <= 10) return 0.25; // minor gains left
  if (rank <= 30) return 1.0; // the sweet spot
  if (rank <= 60) return 0.75;
  return 0.55;
}

// ===========================================================================
// 5. Visibility and Share of Voice
// ===========================================================================

/**
 * The rank→reach curve. Position 1 captures most of the traffic; attention falls off a cliff
 * after the first screen.
 */
export function reach(rank) {
  if (rank == null) return 0;
  if (rank === 1) return 1.0;
  if (rank === 2) return 0.75;
  if (rank === 3) return 0.6;
  if (rank <= 5) return 0.45;
  if (rank <= 10) return 0.3;
  if (rank <= 20) return 0.15;
  if (rank <= 50) return 0.06;
  if (rank <= 100) return 0.02;
  return 0.005;
}

/**
 * Visibility and Share of Voice SHARE ONE FORMULA and differ only in what they include.
 * That difference is the insight, so they must not drift apart in implementation.
 *
 * @param {Array} rows {popularity, rank, is_branded}
 * @param {boolean} excludeBranded  false → Visibility; true → Share of Voice
 * @returns {number|null} null when total demand is 0 — never 0, which would read as
 *   "measured, and you capture nothing"
 */
export function visibilityScore(rows, excludeBranded = false) {
  const set = excludeBranded ? rows.filter((r) => !r.is_branded) : rows;

  let weightedReach = 0;
  let totalDemand = 0;
  for (const r of set) {
    const pop = r.popularity;
    if (pop == null) continue;
    totalDemand += pop;
    weightedReach += pop * reach(r.rank ?? null);
  }

  if (totalDemand === 0) return null;
  return Math.round((100 * weightedReach) / totalDemand * 100) / 100;
}

/**
 * Both numbers plus the branded count, computed together so they cannot diverge.
 *
 * Why they diverge is the most useful thing on the dashboard: an app ranks #1-#2 for its own
 * name in every market, so branded terms pull Visibility up hard. Strip them out and what
 * remains is how much GENERIC demand the app actually captures. "Visibility 89, Share of
 * Voice 7.7%" says something specific and important — you dominate your own name and almost
 * nothing else.
 */
export function visibilityAndShareOfVoice(rows) {
  return {
    visibility: visibilityScore(rows, false),
    share_of_voice: visibilityScore(rows, true),
    branded_excluded: rows.filter((r) => r.is_branded).length,
    keywords_counted: rows.length,
  };
}

/**
 * Branded classification (§5.1). Deliberately conservative, and users can override per
 * keyword — a wrong branded flag silently corrupts Share of Voice.
 */
export function isBranded(term, { appName, developerName } = {}) {
  const norm = (s) =>
    String(s ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // accent-insensitive
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const t = norm(term);
  if (!t) return false;

  const candidates = [];
  const name = norm(appName);
  const dev = norm(developerName);
  if (name) {
    candidates.push(name);
    // The distinctive leading token of "Mindset: Daily Motivation App" is "mindset".
    const lead = name.split(" ")[0];
    if (lead && lead.length >= 4) candidates.push(lead);
  }
  if (dev) candidates.push(dev);

  const bag = new Set(t.split(" "));
  return candidates.some((c) => c && (t.includes(c) || bag.has(c)));
}

// ===========================================================================
// 7. Competitive position buckets
// ===========================================================================

/**
 * The four buckets, using the thresholds the reference product PUBLISHES (§7). They are not
 * arbitrary and they are well-chosen, so they are the defaults:
 *
 *   GAP      — a competitor in the TOP 30 within the last 7 days, and we have no rank.
 *              Requiring top-30 matters: a competitor at #180 is not evidence of opportunity.
 *   WINNABLE — a gap that ALSO has difficulty ≤40 and popularity ≥20. Without the popularity
 *              floor the list fills with easy keywords nobody searches, which is this
 *              feature's most common failure mode.
 *   THREAT   — defined by MOVEMENT, not position: a competitor climbed ≥5 places INTO the
 *              top 20 versus a ~2-week baseline. One parked at #4 forever is not news.
 *   LEAD     — we are top 10 AND ahead of every tracked competitor. Being #90 while they are
 *              #140 is not a lead.
 *
 * @returns {{bucket: string|null, from_rank: number|null, to_rank: number|null}}
 */
export function competitiveBucket({
  ourRank = null,
  competitors = [], // [{app_id, rank, rank_7d_ago, rank_14d_ago, best_rank_7d}]
  difficulty: diff = null,
  popularity = null,
} = {}) {
  const ranked = competitors.filter((c) => c.rank != null);

  // LEAD — we are top 10 and ahead of all of them.
  if (ourRank != null && ourRank <= 10 && ranked.every((c) => c.rank > ourRank)) {
    return { bucket: "lead", from_rank: null, to_rank: null, best_competitor: null };
  }

  // THREAT — a competitor climbed >= 5 places into the top 20 vs a ~2-week baseline, or
  // newly entered the top 20 (from_rank null).
  //
  // Requires that WE have a rank: the spec scopes threats to "one of OUR tracked keywords",
  // and there is nothing to be threatened on a keyword we do not rank for at all. Without
  // this guard every unranked keyword with a top-20 competitor reports as a threat and never
  // reaches the gap bucket where it belongs — which is also what makes the two mutually
  // exclusive, so the evaluation order below stops mattering.
  if (ourRank != null) for (const c of ranked) {
    const baseline = c.rank_14d_ago ?? null;

    // `baseline_observed` distinguishes "we CHECKED two weeks ago and they were not in the
    // top 20" from "we have no data that far back". Only the first is movement.
    //
    // Without this the bucket is a false-positive machine: on a fresh install nothing has a
    // 14-day baseline, so every competitor sitting in the top 20 reads as having just
    // arrived, and the Threats tab fills up on day one with apps that have not moved at all.
    const observed = c.baseline_observed ?? baseline != null;
    if (!observed) continue;

    const enteredTop20 = c.rank <= 20 && baseline == null; // checked, and they were absent
    const climbedInto = c.rank <= 20 && baseline != null && baseline - c.rank >= 5;
    if (enteredTop20 || climbedInto) {
      return { bucket: "threat", from_rank: baseline, to_rank: c.rank, best_competitor: c.app_id ?? null };
    }
  }

  // GAP — a competitor in the top 30 in the last 7 days, and we do not rank.
  const inTop30 = ranked
    .filter((c) => Math.min(c.rank ?? Infinity, c.best_rank_7d ?? Infinity) <= 30)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

  if (ourRank == null && inTop30.length) {
    const best = inTop30[0];
    // WINNABLE is a refinement of gap, not a fifth state.
    const winnable = diff != null && diff <= 40 && popularity != null && popularity >= 20;
    return {
      bucket: winnable ? "winnable" : "gap",
      from_rank: null,
      to_rank: best.rank,
      best_competitor: best.app_id ?? null,
    };
  }

  return { bucket: null, from_rank: null, to_rank: null, best_competitor: null };
}

/** Display caps the reference product uses. Every bucket sorts by opportunity descending. */
export const BUCKET_CAPS = { gap: 25, winnable: 25, threat: 10, lead: 10 };

// ===========================================================================
// 8. Est. #1 downloads (iOS only)
// ===========================================================================

/**
 * ⚠️ This curve is VENDOR FOLKLORE, not an Apple specification. Apple has never published an
 * SP→impressions mapping; the constants come from a third-party fit. It is defensible as a
 * rough monotonic mapping (SP genuinely is exponential rather than linear) and using it puts
 * us on par with competitors who use the same numbers — but its output must never be
 * presented as measured, and nothing load-bearing may be built on the specific constants.
 *
 * Sanity: SP 59 → ~9,565 impressions/day → ~670 downloads at rank 1.
 */
export function dailyImpressions(searchPopularity) {
  if (searchPopularity == null) return null;
  return 254.4443 * Math.exp(0.0615 * searchPopularity);
}

const CTR_CVR_AT_RANK_1 = 0.07; // implied by an observed reference implementation; calibrate against real ASC data

export function estDownloadsAtRank1({ popularity, platform = "ios" } = {}) {
  // iOS only: the curve is calibrated to Apple's SP scale and means nothing without it.
  if (platform !== "ios" || popularity == null) return null;
  const impressions = dailyImpressions(popularity);
  if (impressions == null) return null;
  // 2 significant figures. "670", not "672.4".
  return roundToSigFigs(impressions * CTR_CVR_AT_RANK_1, 2);
}

// ===========================================================================
// 9. Revenue estimate
// ===========================================================================

const REVENUE_FLOOR_USD = 5000;

/**
 * Public data only. Confidence must be reported and the floor must be honoured.
 *
 * iOS is inherently lower-confidence than Android because Apple hides install counts, so iOS
 * installs are modelled from rating_count via a category ratings-per-install benchmark — the
 * weakest link in the whole chain, and why iOS never scores better than 'low'.
 */
export function revenueEstimate({
  platform = "ios",
  realInstalls = null,
  ratingCount = null,
  ratingsPerInstall = 0.012, // ~1.2% of installers rate; category benchmark
  priceCents = 0,
  iaps = [],
  conversion = 0.02, // free → paying, category benchmark
  retentionMonths = 6,
  lifetimeMonths = null,
} = {}) {
  const model = revenueModel({ priceCents, iaps });

  // Installs per month.
  let monthlyInstalls = null;
  let confidence = "low";
  const factors = [];

  if (platform === "android" && typeof realInstalls === "number" && realInstalls > 0) {
    const months = Math.max(lifetimeMonths ?? 24, 1);
    monthlyInstalls = realInstalls / months;
    confidence = "medium";
    factors.push(`Play publishes an exact lifetime install count (${realInstalls.toLocaleString()}), spread over ~${months} months.`);
  } else if (typeof ratingCount === "number" && ratingCount > 0) {
    const totalInstalls = ratingCount / ratingsPerInstall;
    const months = Math.max(lifetimeMonths ?? 24, 1);
    monthlyInstalls = totalInstalls / months;
    confidence = "low";
    factors.push(
      `Apple never exposes install counts, so installs are modelled from ${ratingCount.toLocaleString()} ratings ` +
      `at an assumed ${(ratingsPerInstall * 100).toFixed(1)}% rating rate. This is the weakest input.`,
    );
  }

  if (monthlyInstalls == null) {
    return { model, confidence: "low", monthly_usd_low: null, monthly_usd_high: null, display: "—", factors: ["No install or rating signal available."] };
  }

  // ARPU from the REAL scraped IAP prices, not a guess.
  let arpuCents = 0;
  if (model === "paid") {
    arpuCents = priceCents;
    factors.push(`Paid app at ${(priceCents / 100).toFixed(2)}, no in-app purchases found.`);
  } else if (iaps.length) {
    const annualised = iaps.map((i) => i.annualised_cents).filter((n) => typeof n === "number" && n > 0);
    const medianAnnual = median(annualised);
    if (medianAnnual != null) {
      const monthly = medianAnnual / 12;
      arpuCents = monthly * Math.min(retentionMonths, 12) / Math.min(retentionMonths, 12); // monthly run-rate
      arpuCents = monthly;
      factors.push(`ARPU from ${iaps.length} real scraped in-app prices (median annualised ${(medianAnnual / 100).toFixed(0)} USD).`);
      confidence = confidence === "medium" ? "medium" : "low";
    }
  } else {
    factors.push("No in-app purchases found on the store page; treated as ad-supported with no modelled ARPU.");
  }

  const retention = model === "subscription" ? Math.min(retentionMonths / 12, 1) : 1;
  const payingUsers = model === "paid" ? monthlyInstalls : monthlyInstalls * conversion;
  const monthlyUsd = (payingUsers * arpuCents * retention) / 100;

  factors.push(`Assumes a ${(conversion * 100).toFixed(1)}% free-to-paid conversion and ~${retentionMonths} months of retention.`);

  const low = roundToSigFigs(monthlyUsd * 0.6, 2);
  const high = roundToSigFigs(monthlyUsd * 1.6, 2);

  return {
    model,
    confidence,
    monthly_usd_low: low == null ? null : Math.round(low),
    monthly_usd_high: high == null ? null : Math.round(high),
    // Never display below $5K/mo. Precision you don't have is a lie.
    display: monthlyUsd < REVENUE_FLOOR_USD ? `<$${REVENUE_FLOOR_USD / 1000}K/mo` : `${formatMoneyShort(monthlyUsd)}/mo`,
    monthly_usd: Math.round(monthlyUsd),
    factors,
  };
}

export function revenueModel({ priceCents = 0, iaps = [] } = {}) {
  const hasIap = iaps.length > 0;
  const hasSub = iaps.some((i) => i.is_subscription);
  if (priceCents > 0 && !hasIap) return "paid";
  if (hasSub) return "subscription";
  if (priceCents === 0 && hasIap) return "freemium";
  if (priceCents === 0 && !hasIap) return "ad_supported";
  return "unknown";
}

function formatMoneyShort(usd) {
  if (usd >= 1_000_000) return `$${roundToSigFigs(usd / 1_000_000, 2)}M`;
  if (usd >= 1000) return `$${Math.round(usd / 1000)}K`;
  return `$${Math.round(usd)}`;
}

// ===========================================================================
// 9.5 ASO Score (0-100) — the listing audit
// ===========================================================================

/**
 * Nine checks whose maximum scores sum to EXACTLY 100. The sum-to-100 property is what makes
 * the score self-explaining.
 *
 * The tips are the product here. A bare 76/100 changes nothing; nine specific instructions
 * change a listing. Every tip names the fix.
 */
export function asoScore(listing = {}) {
  const {
    name = "",
    description = "",
    screenshot_urls = [],
    rating_average = null,
    rating_count = null,
    version_released_at = null,
    release_notes = "",
    now = Date.now(),
  } = listing;

  const checks = [];
  const add = (name_, score_, maxScore, tip) =>
    checks.push({
      name: name_,
      score: Math.round(score_),
      maxScore,
      status: score_ >= maxScore * 0.8 ? "good" : score_ >= maxScore * 0.5 ? "fair" : "poor",
      tip,
    });

  // 1. Title length — 15
  const titleLen = name.length;
  if (titleLen >= 25) add("Title Length", 15, 15, `${titleLen}/30 characters used — good use of the space you get.`);
  else if (titleLen >= 18) add("Title Length", 10, 15, `${titleLen}/30 characters. You have ${30 - titleLen} left — add a keyword phrase.`);
  else if (titleLen > 0) add("Title Length", 4, 15, `Your title is very short (${titleLen}/30). The App Store allows 30 characters — use them for keywords.`);
  else add("Title Length", 0, 15, "No title found.");

  // 2. Title keywords — 10
  const titleWords = name.split(/[\s:—–\-|]+/).filter(Boolean);
  if (titleWords.length >= 4) add("Title Keywords", 10, 10, "Your title carries descriptive keywords alongside the brand.");
  else if (titleWords.length >= 2) add("Title Keywords", 6, 10, "Add one or two more descriptive words to the title — it is the highest-weighted field.");
  else add("Title Keywords", 2, 10, "Single-word title. Add keywords that describe what your app does.");

  // 3. Description length — 10
  const descLen = description.length;
  if (descLen >= 2000) add("Description Length", 10, 10, `${descLen.toLocaleString()} characters — substantial.`);
  else if (descLen >= 800) add("Description Length", 6, 10, `${descLen.toLocaleString()} characters. Aim for 2,000+ to cover more search intent.`);
  else if (descLen > 0) add("Description Length", 3, 10, `Only ${descLen} characters. Write at least 2,000 — on Google Play every word is indexed.`);
  else add("Description Length", 0, 10, "No description found.");

  // 4. Description quality — 10 (structure + keyword variety)
  const paragraphs = description.split(/\n\s*\n/).filter((p) => p.trim().length > 40).length;
  const bullets = (description.match(/^[\s]*[•\-*✓★]/gm) ?? []).length;
  const uniqueWords = new Set(description.toLowerCase().match(/\p{L}{4,}/gu) ?? []).size;
  let quality = 0;
  if (paragraphs >= 3) quality += 4;
  else if (paragraphs >= 1) quality += 2;
  if (bullets >= 3) quality += 3;
  if (uniqueWords >= 150) quality += 3;
  else if (uniqueWords >= 60) quality += 1;
  add(
    "Description Quality",
    quality,
    10,
    quality >= 8
      ? "Well structured with good keyword variety."
      : `Break the description into short paragraphs with a bulleted feature list — currently ${paragraphs} paragraph(s), ${bullets} bullet(s), ${uniqueWords} distinct words.`,
  );

  // 5. Screenshots — 15
  const shots = screenshot_urls.length;
  if (shots >= 6) add("Screenshots", 15, 15, `${shots} screenshots — you are using the full carousel.`);
  else if (shots >= 3) add("Screenshots", 9, 15, `${shots} screenshots. Add up to 10; the first three decide the tap.`);
  else if (shots > 0) add("Screenshots", 4, 15, `Only ${shots} screenshot(s). Add at least 3 with captions — this is the biggest conversion lever on the page.`);
  else add("Screenshots", 0, 15, "No screenshots found for this storefront.");

  // 6. Rating — 15
  if (rating_average == null) add("Rating", 0, 15, "No rating yet. Prompt happy users after a success moment.");
  else if (rating_average >= 4.5) add("Rating", 15, 15, `${rating_average.toFixed(1)}★ — excellent, and it lifts both ranking and conversion.`);
  else if (rating_average >= 4.0) add("Rating", 11, 15, `${rating_average.toFixed(1)}★. Getting above 4.5 measurably improves install rate.`);
  else if (rating_average >= 3.0) add("Rating", 5, 15, `${rating_average.toFixed(1)}★ is holding you back. Read your 1-2★ reviews for the recurring complaint.`);
  else add("Rating", 1, 15, `${rating_average.toFixed(1)}★ is actively costing installs. Fix the top complaint before spending on acquisition.`);

  // 7. Review count — 10
  const reviews = rating_count ?? 0;
  if (reviews >= 10_000) add("Review Count", 10, 10, `${reviews.toLocaleString()} ratings — strong social proof.`);
  else if (reviews >= 1000) add("Review Count", 7, 10, `${reviews.toLocaleString()} ratings. More volume also raises your difficulty ceiling against rivals.`);
  else if (reviews >= 100) add("Review Count", 4, 10, `${reviews.toLocaleString()} ratings. Add an in-app prompt after a positive moment.`);
  else add("Review Count", 1, 10, `Only ${reviews} ratings. This is the cheapest ranking factor you control.`);

  // 8. Recent update — 10
  const days = version_released_at ? (now - new Date(version_released_at).getTime()) / 86_400_000 : null;
  if (days == null) add("Recent Update", 0, 10, "No release date found.");
  else if (days <= 30) add("Recent Update", 10, 10, `Updated ${Math.round(days)} days ago — stores favour apps that are actively maintained.`);
  else if (days <= 90) add("Recent Update", 6, 10, `Updated ${Math.round(days)} days ago. Ship something within 90 days to keep the freshness signal.`);
  else add("Recent Update", 2, 10, `Last updated ${Math.round(days)} days ago. Stores demote stale listings — ship even a small update.`);

  // 9. Release notes — 5
  const notesLen = release_notes.trim().length;
  const lazyNotes = /^(bug ?fixes?|minor (bug ?fixes?|improvements?)|performance improvements?)\.?$/i.test(release_notes.trim());
  if (notesLen >= 120 && !lazyNotes) add("Release Notes", 5, 5, "Detailed release notes — they convert returning visitors.");
  else if (notesLen > 0 && lazyNotes) add("Release Notes", 1, 5, '"Bug fixes" tells a browsing user nothing. Name what got better.');
  else if (notesLen > 0) add("Release Notes", 3, 5, "Expand the release notes — name the specific improvement.");
  else add("Release Notes", 0, 5, "No release notes found.");

  const total = checks.reduce((s, c) => s + c.score, 0);
  const max = checks.reduce((s, c) => s + c.maxScore, 0); // must be exactly 100

  return { score: total, max, checks };
}

// ===========================================================================
// 11. Rank deltas and rollups
// ===========================================================================

/**
 * delta = rank_N_days_ago - rank_today.
 *
 * POSITIVE MEANS IMPROVED, because a better rank is a smaller number. Rank 50 → 20 is an
 * improvement of +30. The sign convention is a real trap; the test for it is written first.
 *
 * Either side missing → null, rendered as an em dash. `0` means measured and unchanged, and
 * the two must stay visually distinct in the UI.
 */
export function delta(rankThen, rankNow) {
  if (rankThen == null || rankNow == null) return null;
  return rankThen - rankNow;
}

/** Averages over days WITH data, ignoring gaps. */
export function average(ranks) {
  const clean = ranks.filter((r) => typeof r === "number" && r > 0);
  if (!clean.length) return null;
  return Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 100) / 100;
}

/**
 * Bracket counts for the stacked Ranked Keywords chart (§11.1).
 * Unranked keywords are EXCLUDED from all five, not dumped into 100+.
 */
export function bracketCounts(ranks) {
  const out = { top3: 0, r4_10: 0, r11_30: 0, r31_100: 0, r100_plus: 0, ranked: 0 };
  for (const rank of ranks) {
    if (rank == null || rank <= 0) continue; // unranked is excluded entirely
    out.ranked++;
    if (rank <= 3) out.top3++;
    else if (rank <= 10) out.r4_10++;
    else if (rank <= 30) out.r11_30++;
    else if (rank <= 100) out.r31_100++;
    else out.r100_plus++;
  }
  return out;
}

/** Which colour bracket a rank belongs to, shared by the chart and the rank pills. */
export function rankBracket(rank) {
  if (rank == null) return null;
  if (rank <= 3) return "top3";
  if (rank <= 10) return "r4_10";
  if (rank <= 30) return "r11_30";
  if (rank <= 100) return "r31_100";
  return "r100_plus";
}

// ===========================================================================
// 12. Alert evaluation
// ===========================================================================

export const ALERT_DEFAULT_THRESHOLDS = { rank_drop: 5, rank_gain: 5 };

/**
 * Evaluates the 8 alert rules for one (app, keyword) pair.
 *
 * Threshold model: `threshold` is what the user set (null means "use the default") and
 * `effective_threshold` is what actually fires. Exposing both saves a lot of "why didn't I
 * get an alert".
 *
 * @param {object} settings  {kind: {enabled, threshold}} — everything defaults off
 */
export function evaluateAlerts({ today, yesterday, settings = {}, ratingToday = null, ratingYesterday = null, newReviews = null, reviewBaseline = null, competitorEvents = 0 } = {}) {
  const fired = [];
  const on = (kind) => settings[kind]?.enabled === true;
  const threshold = (kind) => settings[kind]?.threshold ?? ALERT_DEFAULT_THRESHOLDS[kind] ?? null;

  const now = today?.rank ?? null;
  const then = yesterday?.rank ?? null;

  // rank_drop — fell by at least N, or fell out of the crawl entirely
  if (on("rank_drop")) {
    const t = threshold("rank_drop");
    const fellOut = then != null && now == null;
    if (fellOut || (then != null && now != null && now - then >= t)) {
      fired.push({ kind: "rank_drop", from_rank: then, to_rank: now, effective_threshold: t });
    }
  }

  // out_of_top10 — was <=10, now >10 or unranked
  if (on("out_of_top10") && then != null && then <= 10 && (now == null || now > 10)) {
    fired.push({ kind: "out_of_top10", from_rank: then, to_rank: now, effective_threshold: null });
  }

  // new_ranking — no previous rank, now ranked
  if (on("new_ranking") && then == null && now != null) {
    fired.push({ kind: "new_ranking", from_rank: null, to_rank: now, effective_threshold: null });
  }

  // rank_gain — climbed by at least N
  if (on("rank_gain")) {
    const t = threshold("rank_gain");
    if (then != null && now != null && then - now >= t) {
      fired.push({ kind: "rank_gain", from_rank: then, to_rank: now, effective_threshold: t });
    }
  }

  // entered_top10 — was >10 or unranked, now <=10
  if (on("entered_top10") && now != null && now <= 10 && (then == null || then > 10)) {
    fired.push({ kind: "entered_top10", from_rank: then, to_rank: now, effective_threshold: null });
  }

  // rating_drop — average rating fell versus the previous snapshot
  if (on("rating_drop") && ratingToday != null && ratingYesterday != null && ratingToday < ratingYesterday) {
    fired.push({ kind: "rating_drop", from_rank: null, to_rank: null, effective_threshold: null, detail: { from: ratingYesterday, to: ratingToday } });
  }

  // review_spike — today's count > mean + 2σ of the trailing 30 days
  if (on("review_spike") && newReviews != null && reviewBaseline?.mean != null && reviewBaseline?.stddev != null) {
    if (newReviews > reviewBaseline.mean + 2 * reviewBaseline.stddev) {
      fired.push({ kind: "review_spike", from_rank: null, to_rank: null, effective_threshold: null, detail: { count: newReviews, mean: reviewBaseline.mean } });
    }
  }

  // competitor_change — any activity event for a competitor app
  if (on("competitor_change") && competitorEvents > 0) {
    fired.push({ kind: "competitor_change", from_rank: null, to_rank: null, effective_threshold: null, detail: { events: competitorEvents } });
  }

  return fired;
}

/** Mean and standard deviation, for the review-spike baseline. */
export function meanStdDev(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length < 2) return { mean: null, stddev: null, n: clean.length };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (clean.length - 1);
  return { mean: Math.round(mean * 100) / 100, stddev: Math.round(Math.sqrt(variance) * 100) / 100, n: clean.length };
}

/**
 * Quadrant for the /keywords Matrix view. Thresholds are user-draggable and persisted, so
 * they are parameters rather than constants.
 */
export function quadrantFor({ difficulty: diff, popularity }, { difficultySplit = 50, popularitySplit = 25 } = {}) {
  if (diff == null || popularity == null) return null;
  const easy = diff < difficultySplit;
  const wanted = popularity >= popularitySplit;
  if (wanted && easy) return "quick_wins";
  if (wanted && !easy) return "worth_fighting";
  if (!wanted && easy) return "easy_pickings";
  return "low_priority";
}

export const QUADRANT_LABELS = {
  quick_wins: "Quick Wins",
  worth_fighting: "Worth Fighting For",
  easy_pickings: "Easy Pickings",
  low_priority: "Low Priority",
};
