/**
 * The formatters get their own tests because "a 0 that should have been an em dash" is the
 * single most likely bug in this build, and these functions are where that rule lives.
 */
import { describe, it, expect } from "vitest";
import {
  rank,
  delta,
  deltaTone,
  score,
  popularity,
  popularityIsEstimated,
  percent,
  money,
  count,
  relativeDate,
  shortDate,
  installs,
  toCsv,
  csvCell,
  storeLabel,
  EM_DASH,
} from "./format";

describe("rank — the four-valued state", () => {
  it("renders all five distinct states distinguishably", () => {
    expect(rank({ rank: 42, found: true })).toBe("#42");
    expect(rank({ rank: null, found: false })).toBe("Not ranked");
    expect(rank({ rank: null, found: false, crawl_depth: 200 })).toBe(">200");
    expect(rank({ rank: null, found: false, crawl_depth: 200, last_known_rank: 163 })).toBe(">200 (was #163)");
    expect(rank(null)).toBe(EM_DASH);
    expect(rank({ rank: null, found: false, checked: false })).toBe(EM_DASH);
  });

  it("never renders an unranked keyword as a number", () => {
    for (const state of [{ rank: null, found: false }, { rank: null, found: false, crawl_depth: 250 }]) {
      expect(rank(state)).not.toMatch(/^#\d/);
    }
  });

  it("keeps 'not checked' and 'checked and absent' visually different", () => {
    expect(rank(null)).not.toBe(rank({ rank: null, found: false }));
  });
});

describe("delta — where the missing-≠-zero rule is enforced", () => {
  it("renders +30 for an improvement and -64 for a decline", () => {
    expect(delta(30)).toBe("+30");
    expect(delta(-64)).toBe("-64");
  });

  it("keeps 0 and null visually distinct", () => {
    expect(delta(0)).toBe("0");
    expect(delta(null)).toBe(EM_DASH);
    expect(delta(0)).not.toBe(delta(null));
    expect(delta(undefined)).toBe(EM_DASH);
  });

  it("reports four distinct tones so colour is not the only signal", () => {
    expect(deltaTone(5)).toBe("up");
    expect(deltaTone(-5)).toBe("down");
    expect(deltaTone(0)).toBe("zero");
    expect(deltaTone(null)).toBe("none");
  });
});

describe("popularity — parentheses mean our estimate", () => {
  it("renders the store value alone when it is real", () => {
    expect(popularity({ popularity: 54, popularity_estimate: null })).toBe("54");
  });

  it("renders '5 (28)' when the store floors the value and we substitute", () => {
    expect(popularity({ popularity: 5, popularity_estimate: 28 })).toBe("5 (28)");
    expect(popularityIsEstimated({ popularity: 5, popularity_estimate: 28 })).toBe(true);
  });

  it("renders our estimate in parentheses when there is no store value at all", () => {
    expect(popularity({ popularity: null, popularity_estimate: 41 })).toBe("(41)");
    expect(popularityIsEstimated({ popularity: null, popularity_estimate: 41 })).toBe(true);
  });

  it("does not double up when the two agree", () => {
    expect(popularity({ popularity: 30, popularity_estimate: 30 })).toBe("30");
    expect(popularityIsEstimated({ popularity: 30, popularity_estimate: 30 })).toBe(false);
  });

  it("is an em dash when nothing is known", () => {
    expect(popularity({ popularity: null, popularity_estimate: null })).toBe(EM_DASH);
    expect(popularity(null)).toBe(EM_DASH);
  });
});

describe("the rest", () => {
  it("score handles null", () => {
    expect(score(61)).toBe("61");
    expect(score(null)).toBe(EM_DASH);
    expect(score(0)).toBe("0"); // a measured zero is a real value
  });

  it("percent renders one decimal", () => {
    expect(percent(7.7)).toBe("7.7%");
    expect(percent(null)).toBe(EM_DASH);
  });

  it("money ALWAYS carries its currency and honours the floor caller-side", () => {
    expect(money(27_100_000)).toBe("$271K");
    expect(money(27_100_000, "CAD")).toBe("CA$271K");
    expect(money(1_500_000_00)).toBe("$1.5M"); // 150,000,000 cents = $1.5M
    expect(money(null)).toBe(EM_DASH);
  });

  it("count groups thousands", () => {
    expect(count(266_912)).toBe("266,912");
    expect(count(null)).toBe(EM_DASH);
  });

  it("installs distinguishes 'no install count exists' from zero", () => {
    // Apple exposes no install count at any price, so iOS is always an em dash here.
    expect(installs(null)).toBe(EM_DASH);
    expect(installs(360_532_190)).toBe("360.53M");
    expect(installs(0)).toBe("0");
  });

  it("relativeDate says 'never' rather than an em dash, because null means never here", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    expect(relativeDate(null, now)).toBe("never");
    expect(relativeDate("2026-07-31T11:00:00Z", now)).toBe("1h ago");
    expect(relativeDate("2026-07-30T12:00:00Z", now)).toBe("yesterday");
    expect(relativeDate("2026-07-17T12:00:00Z", now)).toBe("2w ago");
  });

  it("shortDate says Today for today and 'Jul 22' otherwise", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    expect(shortDate(now, now)).toBe("Today");
    expect(shortDate("2026-07-22T12:00:00Z", now)).toBe("Jul 22");
    expect(shortDate(null, now)).toBe(EM_DASH);
  });

  it("labels the store, because a rank without one is meaningless", () => {
    expect(storeLabel("ios")).toBe("App Store");
    expect(storeLabel("android")).toBe("Google Play");
    expect(storeLabel(null)).toBe(EM_DASH);
  });

  it("escapes CSV cells containing commas and quotes", () => {
    expect(csvCell('alarm, clock')).toBe('"alarm, clock"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
    expect(toCsv([{ term: "a,b", rank: 3 }])).toBe('term,rank\n"a,b",3');
  });
});
