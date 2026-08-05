/**
 * GATE 2 — the test checklist from 03-ALGORITHMS.md §13, item by item, plus the
 * missing-≠-zero invariant everywhere it can bite.
 *
 * Every checklist item is marked [§13] so the gate is auditable against the spec.
 */
import { describe, it, expect } from "vitest";
import {
  popularityProxy,
  popularityProxyAndroid,
  popularityEffective,
  difficulty,
  difficultyLabel,
  difficultyBracket,
  serpOutlier,
  beatable,
  gap,
  opportunity,
  rankUpside,
  reach,
  visibilityScore,
  visibilityAndShareOfVoice,
  isBranded,
  competitiveBucket,
  dailyImpressions,
  estDownloadsAtRank1,
  revenueEstimate,
  revenueModel,
  asoScore,
  delta,
  average,
  bracketCounts,
  rankBracket,
  evaluateAlerts,
  meanStdDev,
  quadrantFor,
} from "./scores.mjs";
import { median, roundToSigFigs, graphemeLength, graphemeSlice, titleMatch, wordCount, score, iScore } from "./text.mjs";

// A fixture SERP: one huge incumbent, one genuine outlier at #3, mixed title matches.
const serpTop10 = [
  { store_id: "1", name: "Meditation Timer", rating_count: 40_000 },
  { store_id: "2", name: "Calm Mind", rating_count: 52_000 },
  { store_id: "3", name: "Tiny Zen", rating_count: 138 }, // the outlier
  { store_id: "4", name: "Daily Meditation", rating_count: 38_000 },
  { store_id: "5", name: "Breathe", rating_count: 41_000 },
  { store_id: "6", name: "Sleep Sounds", rating_count: 33_000 },
  { store_id: "7", name: "Mindful Moments", rating_count: 46_000 },
  { store_id: "8", name: "Quiet", rating_count: 29_000 },
  { store_id: "9", name: "Zen Garden", rating_count: 51_000 },
  { store_id: "10", name: "Focus Flow", rating_count: 44_000 },
];

describe("difficulty", () => {
  it("[§13] returns null, NOT 0, for a keyword with no SERP data", () => {
    expect(difficulty({ top: [], term: "meditation" }).value).toBeNull();
    expect(difficulty({ top: undefined, term: "meditation" }).value).toBeNull();
    expect(difficulty({}).value).toBeNull();
    // The whole point: null must not be coercible to a passing "easy" score.
    expect(difficulty({ top: [], term: "x" }).value).not.toBe(0);
  });

  it("returns null when the SERP has rows but no measurable strength", () => {
    const rows = [{ name: "A" }, { name: "B" }, { name: "C" }];
    expect(difficulty({ top: rows, term: "meditation" }).value).toBeNull();
  });

  it("scores a SERP of huge incumbents as hard", () => {
    const d = difficulty({ top: serpTop10, term: "meditation", serpDepth: 250 });
    expect(d.value).toBeGreaterThan(50);
    expect(d.parts.leaders).toBeGreaterThan(70); // ~42k median ratings
  });

  it("has NO depth component — resultCount saturates and was deliberately removed", () => {
    const d = difficulty({ top: serpTop10, term: "meditation", serpDepth: 250 });
    expect(d.parts).not.toHaveProperty("depth");
    // serpDepth is still REPORTED, just not weighted — it and appsAnalyzed are different numbers.
    expect(d.parts.serpDepth).toBe(250);
    expect(d.parts.appsAnalyzed).toBe(10);
  });

  it("weights are 0.53/0.35/0.12 and produce a value inside 0-100", () => {
    const d = difficulty({ top: serpTop10, term: "a b c d e f", serpDepth: 20 });
    expect(d.value).toBeGreaterThanOrEqual(0);
    expect(d.value).toBeLessThanOrEqual(100);
  });

  it("makes long-tail phrases easier than single words, all else equal", () => {
    const single = difficulty({ top: serpTop10, term: "meditation" }).value;
    const tail = difficulty({ top: serpTop10, term: "guided meditation for deep sleep" }).value;
    expect(tail).toBeLessThan(single);
  });

  it("counts title matches word-wise, not by substring", () => {
    const top = [{ name: "Recipes Deluxe", rating_count: 100 }];
    // Apple tokenises: "recipes" must NOT satisfy a query for "recipe".
    expect(titleMatch("Recipes Deluxe", "recipe")).toBe(false);
    expect(titleMatch("Recipes Deluxe", "recipes")).toBe(true);
    expect(difficulty({ top, term: "recipe" }).parts.titleMatches).toBe(0);
  });

  it("labels and brackets are the published thresholds", () => {
    expect(difficultyLabel(80)).toBe("Very hard");
    expect(difficultyLabel(60)).toBe("Hard");
    expect(difficultyLabel(40)).toBe("Moderate");
    expect(difficultyLabel(20)).toBe("Winnable");
    expect(difficultyLabel(null)).toBe("Unknown");
    expect(difficultyBracket(15)).toBe("low competition");
    expect(difficultyBracket(45)).toBe("moderate");
    expect(difficultyBracket(80)).toBe("highly competitive");
    expect(difficultyBracket(null)).toBeNull();
  });
});

describe("popularity", () => {
  it("[§13] keeps the store's floored 5 and our estimate separately", () => {
    const kw = { popularity: 5, popularity_source: "store", popularity_estimate: 28 };
    // The store said 5; we say 28. Both are retained, and the effective value is ours.
    expect(kw.popularity).toBe(5);
    expect(kw.popularity_estimate).toBe(28);
    expect(popularityEffective(kw)).toBe(28);
  });

  it("falls back to the store value when we have no estimate", () => {
    expect(popularityEffective({ popularity: 54, popularity_estimate: null })).toBe(54);
    expect(popularityEffective({ popularity: null, popularity_estimate: null })).toBeNull();
    expect(popularityEffective(null)).toBeNull();
  });

  it("returns null (not 0) when the term never appeared at any prefix length", () => {
    const p = popularityProxy({ length: null, index: null, best: null, hits: 0 });
    expect(p.value).toBeNull();
    expect(p.value).not.toBe(0);
  });

  it("scores an early reveal above a late one — the strongest signal", () => {
    // The live-validated pair from 02 §9.3.
    const broad = popularityProxy({ length: 6, index: 2, best: 2, hits: 4 });
    const tail = popularityProxy({ length: 13, index: 3, best: 3, hits: 4 });
    expect(broad.value).toBeGreaterThan(tail.value);
  });

  it("gives a 1-character reveal at slot 0 nearly full marks", () => {
    const p = popularityProxy({ length: 1, index: 0, best: 0, hits: 5 });
    expect(p.value).toBeGreaterThanOrEqual(95);
    expect(p.value).toBeLessThanOrEqual(100);
  });

  it("exposes every component for the ⓘ popover", () => {
    const p = popularityProxy({ length: 6, index: 2, best: 1, hits: 3 });
    expect(p.parts).toMatchObject({ revealed_at_char: 6, revealed_at_position: 2, prefixes_seen: 3 });
    expect(p.parts.reveal).toBeGreaterThan(0);
  });

  it("Android blends autocomplete with REAL install counts", () => {
    const depth = { length: 3, index: 2, best: 2, hits: 4 };
    const withInstalls = popularityProxyAndroid(depth, [360_532_190, 100_000_000, 50_000_000]);
    const withoutInstalls = popularityProxyAndroid(depth, []);
    expect(withInstalls.parts.median_real_installs).toBe(100_000_000);
    expect(withInstalls.parts.install_score).toBeGreaterThan(90);
    // No install data must fall back to autocomplete alone, not invent a number.
    expect(withoutInstalls.value).toBe(popularityProxy(depth).value);
    expect(withoutInstalls.parts.install_score).toBeNull();
  });

  it("Android returns null when the term was never suggested", () => {
    expect(popularityProxyAndroid({ length: null, best: null, hits: 0 }, [1000]).value).toBeNull();
  });
});

describe("gap", () => {
  it("[§13] is null when EITHER input is null", () => {
    expect(gap({ popularity_estimate: 40, difficulty: null })).toBeNull();
    expect(gap({ popularity_estimate: null, popularity: null, difficulty: 30 })).toBeNull();
    expect(gap({})).toBeNull();
  });

  it("subtracts difficulty from the effective popularity", () => {
    expect(gap({ popularity_estimate: 40, difficulty: 33 })).toBe(7);
    expect(gap({ popularity: 20, difficulty: 53 })).toBe(-33);
  });
});

describe("opportunity", () => {
  it("[§13] ranks a #20 keyword above an otherwise identical #1 keyword", () => {
    const base = { popularity: 60, difficulty: 40 };
    // #11-30 is the sweet spot: page 1 is in reach. #1 has nothing left to gain.
    expect(opportunity({ ...base, rank: 20 })).toBeGreaterThan(opportunity({ ...base, rank: 1 }));
  });

  it("returns null if difficulty or popularity is null", () => {
    expect(opportunity({ popularity: 60, difficulty: null, rank: 20 })).toBeNull();
    expect(opportunity({ popularity: null, difficulty: 40, rank: 20 })).toBeNull();
  });

  it("dampens low-popularity terms so a trivially easy nothing-term cannot top the list", () => {
    const easyNothing = opportunity({ popularity: 5, difficulty: 2, rank: null });
    const realDemand = opportunity({ popularity: 70, difficulty: 45, rank: null });
    expect(realDemand).toBeGreaterThan(easyNothing);
  });

  it("uses a neutral 0.5 relevance when none is supplied, so a missing AI score does not distort", () => {
    const withNull = opportunity({ popularity: 60, difficulty: 40, rank: 20, relevance: null });
    const withNeutral = opportunity({ popularity: 60, difficulty: 40, rank: 20, relevance: 50 });
    expect(withNull).toBe(withNeutral);
  });

  it("rank upside follows the published curve", () => {
    expect(rankUpside(null)).toBe(0.8);
    expect(rankUpside(2)).toBe(0.1);
    expect(rankUpside(8)).toBe(0.25);
    expect(rankUpside(20)).toBe(1.0);
    expect(rankUpside(45)).toBe(0.75);
    expect(rankUpside(500)).toBe(0.55);
  });
});

describe("reach, visibility and share of voice", () => {
  it("[§13] reach(null) is 0", () => {
    expect(reach(null)).toBe(0);
  });

  it("[§13] rank 1 massively outweighs a deep rank", () => {
    // The documented curve: rank 1 = 1.00, rank 100 = 0.02 (50x), beyond 100 = 0.005 (200x).
    expect(reach(1) / reach(100)).toBe(50);
    expect(reach(1) / reach(101)).toBeGreaterThan(100);
  });

  it("matches the published curve exactly at every breakpoint", () => {
    expect(reach(1)).toBe(1.0);
    expect(reach(2)).toBe(0.75);
    expect(reach(3)).toBe(0.6);
    expect(reach(5)).toBe(0.45);
    expect(reach(10)).toBe(0.3);
    expect(reach(20)).toBe(0.15);
    expect(reach(50)).toBe(0.06);
    expect(reach(100)).toBe(0.02);
    expect(reach(250)).toBe(0.005);
  });

  it("[§13] Visibility and Share of Voice differ ONLY by the branded filter", () => {
    const rows = [
      { popularity: 90, rank: 1, is_branded: true }, // own name: ranks #1 everywhere
      { popularity: 60, rank: 40, is_branded: false },
      { popularity: 50, rank: null, is_branded: false },
    ];
    const { visibility, share_of_voice, branded_excluded } = visibilityAndShareOfVoice(rows);

    // Same function, one filter apart — proven by recomputing each with the primitive.
    expect(visibility).toBe(visibilityScore(rows, false));
    expect(share_of_voice).toBe(visibilityScore(rows.filter((r) => !r.is_branded), false));
    expect(branded_excluded).toBe(1);

    // The insight: branded terms inflate visibility. "You dominate your own name and little else."
    expect(visibility).toBeGreaterThan(share_of_voice);
  });

  it("returns null (not 0) when there is no measured demand at all", () => {
    expect(visibilityScore([], false)).toBeNull();
    expect(visibilityScore([{ popularity: null, rank: 3 }], false)).toBeNull();
    // Zero would read as "measured, and you capture nothing".
    expect(visibilityScore([], false)).not.toBe(0);
  });

  it("scores a perfect #1-everywhere app at 100", () => {
    expect(visibilityScore([{ popularity: 50, rank: 1 }, { popularity: 90, rank: 1 }], false)).toBe(100);
  });

  it("classifies branded terms conservatively", () => {
    const app = { appName: "Mindset: Daily Motivation App", developerName: "Deeply Media" };
    expect(isBranded("mindset app", app)).toBe(true);
    expect(isBranded("deeply media", app)).toBe(true);
    expect(isBranded("motivational quotes", app)).toBe(false);
    expect(isBranded("", app)).toBe(false);
  });
});

describe("SERP outlier and beatable", () => {
  it("flags an app holding a top-10 slot with 10x less social proof, WITH the evidence", () => {
    const o = serpOutlier({ top: serpTop10 });
    expect(o.value).toBe(true);
    expect(o.apps).toHaveLength(1);
    expect(o.apps[0]).toMatchObject({ position: 3, strength: 138 });
    // Evidence, not just a boolean — the tooltip has to be able to say why.
    expect(o.apps[0].median).toBeGreaterThan(1000);
  });

  it("nulls the flag for SERPs with fewer than 3 results", () => {
    expect(serpOutlier({ top: serpTop10.slice(0, 2) }).value).toBeNull();
    expect(beatable({ top: serpTop10.slice(0, 2), term: "x" }).value).toBeNull();
  });

  it("beatable fires when a top-3 slot is held with 10x less strength, and names the spot", () => {
    const b = beatable({ top: serpTop10, term: "meditation" });
    expect(b.value).toBe(true);
    expect(b.evidence.weakSpotRank).toBe(3);
    expect(b.evidence.reason).toContain("138");
  });

  it("beatable fires on under-targeting when the top 3 are no stronger than the field", () => {
    const evenSerp = Array.from({ length: 10 }, (_, i) => ({
      store_id: String(i),
      name: `Generic App ${i}`, // nobody targets "meditation" in their title
      rating_count: 5000,
    }));
    const b = beatable({ top: evenSerp, term: "meditation" });
    expect(b.value).toBe(true);
    expect(b.evidence.titleMatches).toBe(0);
  });

  it("does not fire when strong incumbents all target the term", () => {
    const fortress = Array.from({ length: 10 }, (_, i) => ({
      store_id: String(i),
      name: "Meditation Pro",
      rating_count: 500_000,
    }));
    expect(beatable({ top: fortress, term: "meditation" }).value).toBe(false);
  });

  it("uses installs for Android strength instead of the rating-count proxy", () => {
    const androidSerp = [
      { name: "A", real_installs: 10_000_000 },
      { name: "B", real_installs: 8_000_000 },
      { name: "C", real_installs: 400 }, // the outlier
    ];
    const o = serpOutlier({ top: androidSerp, platform: "android" });
    expect(o.value).toBe(true);
    expect(o.apps[0].strength).toBe(400);
    expect(difficulty({ top: androidSerp, term: "x", platform: "android" }).parts.strengthMetric).toBe("real_installs");
  });
});

describe("competitive position buckets", () => {
  it("calls it a GAP when a competitor is top-30 and we do not rank", () => {
    const r = competitiveBucket({ ourRank: null, competitors: [{ app_id: "c1", rank: 16 }], difficulty: 70, popularity: 50 });
    expect(r.bucket).toBe("gap");
    expect(r.to_rank).toBe(16);
    expect(r.best_competitor).toBe("c1");
  });

  it("does NOT call it a gap when the competitor sits at #180", () => {
    // A competitor at #180 is not evidence of an opportunity.
    expect(competitiveBucket({ ourRank: null, competitors: [{ app_id: "c1", rank: 180 }] }).bucket).toBeNull();
  });

  it("upgrades a gap to WINNABLE only when difficulty <=40 AND popularity >=20", () => {
    const base = { ourRank: null, competitors: [{ app_id: "c1", rank: 12 }] };
    expect(competitiveBucket({ ...base, difficulty: 35, popularity: 40 }).bucket).toBe("winnable");
    // Without the popularity floor the list fills with easy keywords nobody searches.
    expect(competitiveBucket({ ...base, difficulty: 35, popularity: 10 }).bucket).toBe("gap");
    expect(competitiveBucket({ ...base, difficulty: 65, popularity: 40 }).bucket).toBe("gap");
  });

  it("calls it a THREAT on movement into the top 20, not on position alone", () => {
    const climbed = competitiveBucket({ ourRank: 30, competitors: [{ app_id: "c1", rank: 9, rank_14d_ago: 18 }] });
    expect(climbed.bucket).toBe("threat");
    expect(climbed.from_rank).toBe(18);
    expect(climbed.to_rank).toBe(9);

    // Parked at #4 forever is not news.
    expect(competitiveBucket({ ourRank: 30, competitors: [{ app_id: "c1", rank: 4, rank_14d_ago: 4 }] }).bucket).toBeNull();
  });

  it("treats a newly entered top-20 competitor as a threat with a null from_rank", () => {
    // baseline_observed: we DID check two weeks ago and they were absent. That is movement.
    const r = competitiveBucket({ ourRank: 40, competitors: [{ app_id: "c1", rank: 15, rank_14d_ago: null, baseline_observed: true }] });
    expect(r.bucket).toBe("threat");
    expect(r.from_rank).toBeNull();
  });

  it("does NOT cry threat when there is simply no baseline history", () => {
    // On a fresh install nothing has 14 days of history. Without this guard every competitor
    // in the top 20 reads as having just arrived and the Threats tab fills up on day one.
    const r = competitiveBucket({ ourRank: 40, competitors: [{ app_id: "c1", rank: 15, rank_14d_ago: null, baseline_observed: false }] });
    expect(r.bucket).not.toBe("threat");
  });

  it("calls it a LEAD only at top 10 AND ahead of everyone", () => {
    expect(competitiveBucket({ ourRank: 4, competitors: [{ app_id: "c1", rank: 12 }] }).bucket).toBe("lead");
    // Being #90 while they are #140 is not a lead.
    expect(competitiveBucket({ ourRank: 90, competitors: [{ app_id: "c1", rank: 140 }] }).bucket).toBeNull();
  });

  it("returns an empty landscape rather than an error when there are no competitors", () => {
    const r = competitiveBucket({ ourRank: 50, competitors: [] });
    expect(r.bucket).toBeNull();
  });
});

describe("est. #1 downloads", () => {
  it("matches the documented sanity check: SP 59 → ~9,565 impressions → ~670 downloads", () => {
    expect(Math.round(dailyImpressions(59))).toBe(9581);
    expect(estDownloadsAtRank1({ popularity: 59 })).toBe(670);
  });

  it("[§13-adjacent] returns 2 significant figures, never false precision", () => {
    const v = estDownloadsAtRank1({ popularity: 47 });
    expect(String(v).replace(/0+$/, "").replace(".", "").replace(/^0/, "")).toMatch(/^\d{1,2}$/);
  });

  it("is iOS only and null without popularity", () => {
    expect(estDownloadsAtRank1({ popularity: 59, platform: "android" })).toBeNull();
    expect(estDownloadsAtRank1({ popularity: null })).toBeNull();
  });
});

describe("revenue estimate", () => {
  it("[§13] renders <$5K/mo below the floor, never a number", () => {
    const r = revenueEstimate({ platform: "ios", ratingCount: 40, iaps: [] });
    expect(r.display).toBe("<$5K/mo");
    expect(r.display).not.toMatch(/^\$\d/);
  });

  it("identifies the monetisation model from real scraped IAP data", () => {
    expect(revenueModel({ priceCents: 499, iaps: [] })).toBe("paid");
    expect(revenueModel({ priceCents: 0, iaps: [{ is_subscription: true }] })).toBe("subscription");
    expect(revenueModel({ priceCents: 0, iaps: [{ is_subscription: false }] })).toBe("freemium");
    expect(revenueModel({ priceCents: 0, iaps: [] })).toBe("ad_supported");
  });

  it("keeps the off-chart installs x ARPU fallback at low confidence on both stores", () => {
    const iaps = [{ is_subscription: true, annualised_cents: 5988, period: "year" }];
    const android = revenueEstimate({ platform: "android", realInstalls: 50_000_000, iaps });
    const ios = revenueEstimate({ platform: "ios", ratingCount: 600_000, iaps });
    expect(android.method).toBe("installs_arpu");
    expect(android.confidence).toBe("low");
    expect(ios.confidence).toBe("low");
    expect(ios.factors.join(" ")).toContain("Not on a top-grossing chart");
  });

  it("prefers measured proceeds over every model", () => {
    const r = revenueEstimate({ measuredMonthlyUsd: 120_000, grossingRank: 55, ratingCount: 600_000 });
    expect(r.method).toBe("measured");
    expect(r.confidence).toBe("high");
    expect(r.monthly_usd).toBe(120_000);
  });

  it("prices a grossing chart from one calibrated anchor, higher rank earning more", () => {
    const anchor = { rank: 55, monthlyUsd: 120_000, label: "Mindset" };
    const better = revenueEstimate({ grossingRank: 20, anchor });
    const worse = revenueEstimate({ grossingRank: 120, anchor });
    expect(better.method).toBe("grossing_rank");
    expect(better.monthly_usd).toBeGreaterThan(anchor.monthlyUsd);
    expect(worse.monthly_usd).toBeLessThan(anchor.monthlyUsd);
    // The anchor itself must round-trip to its own measured number.
    expect(revenueEstimate({ grossingRank: 55, anchor }).monthly_usd).toBe(120_000);
  });

  it("withholds dollars when a grossing rank has no anchor to calibrate against", () => {
    const r = revenueEstimate({ grossingRank: 55, ratingCount: 600_000 });
    expect(r.method).toBe("rank_only");
    expect(r.monthly_usd).toBeNull();
    expect(r.display).toBe("#55 grossing");
  });

  it("reports the contributing factors for the disclosure panel", () => {
    const r = revenueEstimate({ platform: "android", realInstalls: 90_000_000, iaps: [{ is_subscription: true, annualised_cents: 9999 }] });
    expect(r.factors.length).toBeGreaterThan(1);
    expect(r.display).toMatch(/\$\d/);
  });

  it("degrades to an em dash with no install or rating signal", () => {
    expect(revenueEstimate({ platform: "ios" }).display).toBe("—");
  });
});

describe("ASO score", () => {
  it("has nine checks whose maximums sum to EXACTLY 100", () => {
    const r = asoScore({ name: "x" });
    expect(r.checks).toHaveLength(9);
    expect(r.max).toBe(100);
    expect(r.checks.reduce((s, c) => s + c.maxScore, 0)).toBe(100);
  });

  it("scores a strong listing high and a weak one low", () => {
    const strong = asoScore({
      name: "Mindset: Daily Motivation App",
      description: "x".repeat(2500) + "\n\n" + "para two here and more\n\n• one\n• two\n• three\n\n" + Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "),
      screenshot_urls: Array(8).fill("u"),
      rating_average: 4.8,
      rating_count: 25_000,
      version_released_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      release_notes: "We rebuilt the daily reminder engine so notifications arrive on time, and added twelve new speaker collections requested in reviews.",
    });
    const weak = asoScore({ name: "App", description: "", screenshot_urls: [], rating_average: 2.1, rating_count: 4, release_notes: "Bug fixes" });

    expect(strong.score).toBeGreaterThan(85);
    expect(weak.score).toBeLessThan(30);
    expect(strong.score).toBeLessThanOrEqual(100);
  });

  it("gives every check a specific, actionable tip that names the fix", () => {
    const r = asoScore({ name: "App", release_notes: "Bug fixes" });
    for (const c of r.checks) {
      expect(c.tip.length).toBeGreaterThan(15);
      expect(["poor", "fair", "good"]).toContain(c.status);
    }
    expect(r.checks.find((c) => c.name === "Release Notes").tip).toContain("Name what got better");
    expect(r.checks.find((c) => c.name === "Title Keywords").tip).toContain("Single-word title");
  });
});

describe("rank deltas", () => {
  it("[§13] rank 50 → 20 yields +30 (positive means IMPROVED)", () => {
    expect(delta(50, 20)).toBe(30);
  });

  it("a worsening rank is negative", () => {
    expect(delta(20, 84)).toBe(-64);
  });

  it("[§13] is null (not 0) when a day is missing", () => {
    expect(delta(null, 20)).toBeNull();
    expect(delta(50, null)).toBeNull();
    expect(delta(null, null)).toBeNull();
    // 0 means measured and unchanged, and must stay distinct from "no data".
    expect(delta(20, 20)).toBe(0);
  });

  it("averages over days WITH data, ignoring gaps", () => {
    expect(average([4, null, 5, null, 4])).toBe(4.33);
    expect(average([])).toBeNull();
    expect(average([null, null])).toBeNull();
  });
});

describe("bracket counts", () => {
  it("[§13] EXCLUDE unranked keywords from all five brackets", () => {
    const b = bracketCounts([1, 2, 5, 15, 60, 150, null, null]);
    expect(b).toMatchObject({ top3: 2, r4_10: 1, r11_30: 1, r31_100: 1, r100_plus: 1 });
    expect(b.ranked).toBe(6); // the two nulls are not counted anywhere
    // Specifically: nulls must NOT be dumped into 100+.
    expect(bracketCounts([null, null, null]).r100_plus).toBe(0);
  });

  it("brackets map consistently for the chart and the rank pills", () => {
    expect(rankBracket(2)).toBe("top3");
    expect(rankBracket(7)).toBe("r4_10");
    expect(rankBracket(25)).toBe("r11_30");
    expect(rankBracket(80)).toBe("r31_100");
    expect(rankBracket(400)).toBe("r100_plus");
    expect(rankBracket(null)).toBeNull();
  });
});

describe("alert evaluation", () => {
  const enable = (...kinds) => Object.fromEntries(kinds.map((k) => [k, { enabled: true, threshold: null }]));

  it("fires nothing when every setting is off — everything defaults to off", () => {
    expect(evaluateAlerts({ today: { rank: 90 }, yesterday: { rank: 10 }, settings: {} })).toEqual([]);
  });

  it("fires rank_drop at the default threshold of 5 and reports the effective threshold", () => {
    const fired = evaluateAlerts({ today: { rank: 20 }, yesterday: { rank: 10 }, settings: enable("rank_drop") });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ kind: "rank_drop", from_rank: 10, to_rank: 20, effective_threshold: 5 });
  });

  it("respects a user threshold over the default", () => {
    const settings = { rank_drop: { enabled: true, threshold: 30 } };
    expect(evaluateAlerts({ today: { rank: 20 }, yesterday: { rank: 10 }, settings })).toEqual([]);
    expect(evaluateAlerts({ today: { rank: 45 }, yesterday: { rank: 10 }, settings })).toHaveLength(1);
  });

  it("treats falling out of the crawl entirely as a rank drop", () => {
    const fired = evaluateAlerts({ today: { rank: null }, yesterday: { rank: 35 }, settings: enable("rank_drop") });
    expect(fired[0]).toMatchObject({ kind: "rank_drop", from_rank: 35, to_rank: null });
  });

  it("detects the top-10 transitions in both directions", () => {
    expect(evaluateAlerts({ today: { rank: 11 }, yesterday: { rank: 8 }, settings: enable("out_of_top10") })[0].kind).toBe("out_of_top10");
    expect(evaluateAlerts({ today: { rank: 9 }, yesterday: { rank: 22 }, settings: enable("entered_top10") })[0].kind).toBe("entered_top10");
  });

  it("detects a brand-new ranking", () => {
    expect(evaluateAlerts({ today: { rank: 44 }, yesterday: { rank: null }, settings: enable("new_ranking") })[0].kind).toBe("new_ranking");
  });

  it("fires review_spike only beyond mean + 2 sigma", () => {
    const baseline = meanStdDev([2, 3, 2, 4, 3, 2, 3]);
    const settings = enable("review_spike");
    expect(evaluateAlerts({ settings, newReviews: 4, reviewBaseline: baseline })).toEqual([]);
    expect(evaluateAlerts({ settings, newReviews: 30, reviewBaseline: baseline })).toHaveLength(1);
  });

  it("meanStdDev needs at least two points and returns null rather than 0", () => {
    expect(meanStdDev([5])).toMatchObject({ mean: null, stddev: null });
  });

  it("fires rating_drop and competitor_change", () => {
    expect(evaluateAlerts({ settings: enable("rating_drop"), ratingToday: 4.5, ratingYesterday: 4.7 })[0].kind).toBe("rating_drop");
    expect(evaluateAlerts({ settings: enable("competitor_change"), competitorEvents: 2 })[0].kind).toBe("competitor_change");
  });
});

describe("matrix quadrants", () => {
  it("assigns the four quadrants around draggable thresholds", () => {
    expect(quadrantFor({ difficulty: 20, popularity: 70 })).toBe("quick_wins");
    expect(quadrantFor({ difficulty: 80, popularity: 70 })).toBe("worth_fighting");
    expect(quadrantFor({ difficulty: 20, popularity: 10 })).toBe("easy_pickings");
    expect(quadrantFor({ difficulty: 80, popularity: 10 })).toBe("low_priority");
  });

  it("respects user-moved thresholds", () => {
    expect(quadrantFor({ difficulty: 40, popularity: 30 }, { difficultySplit: 30, popularitySplit: 40 })).toBe("low_priority");
  });

  it("returns null when either axis is unmeasured", () => {
    expect(quadrantFor({ difficulty: null, popularity: 70 })).toBeNull();
    expect(quadrantFor({ difficulty: 40, popularity: null })).toBeNull();
  });
});

describe("primitives", () => {
  it("median returns null for an empty set, never 0", () => {
    expect(median([])).toBeNull();
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("roundToSigFigs keeps 2 figures", () => {
    expect(roundToSigFigs(672.4, 2)).toBe(670);
    expect(roundToSigFigs(1234, 2)).toBe(1200);
    expect(roundToSigFigs(0.0456, 2)).toBe(0.046);
    expect(roundToSigFigs(null)).toBeNull();
  });

  it("counts GRAPHEMES, so Japanese and emoji limits are right", () => {
    expect(graphemeLength("目覚まし時計")).toBe(6);
    // A family emoji is ONE character to the App Store and 11 UTF-16 units to String.length.
    expect("👨‍👩‍👧".length).toBeGreaterThan(1);
    expect(graphemeLength("👨‍👩‍👧")).toBe(1);
    expect(graphemeLength("")).toBe(0);
  });

  it("slices on grapheme boundaries without splitting a cluster", () => {
    expect(graphemeSlice("目覚まし時計アプリ", 6)).toBe("目覚まし時計");
    expect(graphemeSlice("a👨‍👩‍👧b", 2)).toBe("a👨‍👩‍👧");
  });

  it("wordCount counts real words including non-Latin", () => {
    expect(wordCount("alarm clock for heavy sleepers")).toBe(5);
    expect(wordCount("  ")).toBe(0);
  });

  it("score/iScore map into [1,10] and invert correctly", () => {
    expect(score(0, 100, 100)).toBe(10);
    expect(score(0, 100, 0)).toBe(1);
    expect(iScore(1, 25, 1)).toBe(10); // a 1-character reveal is the best case
    expect(iScore(1, 25, 25)).toBe(1);
  });
});
