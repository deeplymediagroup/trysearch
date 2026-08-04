import { describe, expect, it } from "vitest";
import { momentumScore } from "./trends.mjs";

const NOW = new Date("2026-08-03T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

describe("momentumScore", () => {
  it("returns 0 when there are no dates in the window", () => {
    expect(momentumScore([], NOW)).toBe(0);
    expect(momentumScore([daysAgo(30)], NOW)).toBe(0); // older than 14 days: ignored
  });

  it("is 100 when every term is first seen in the last 7 days", () => {
    expect(momentumScore([daysAgo(1), daysAgo(3), daysAgo(6)], NOW)).toBe(100);
  });

  it("is 0 when every term is from the prior 7 days", () => {
    expect(momentumScore([daysAgo(8), daysAgo(10), daysAgo(13)], NOW)).toBe(0);
  });

  it("is the recent share of the 14-day window", () => {
    // 3 recent of 4 in-window → 75
    expect(momentumScore([daysAgo(1), daysAgo(2), daysAgo(5), daysAgo(9)], NOW)).toBe(75);
    // 1 recent, 1 prior → 50
    expect(momentumScore([daysAgo(6), daysAgo(8)], NOW)).toBe(50);
  });

  it("treats boundary and messy input sensibly", () => {
    expect(momentumScore([daysAgo(7)], NOW)).toBe(100); // exactly 7 days counts as recent
    expect(momentumScore([daysAgo(14)], NOW)).toBe(0); // exactly 14 days counts as prior
    expect(momentumScore([daysAgo(-1)], NOW)).toBe(100); // slight future skew counts as recent
    expect(momentumScore(["not a date", daysAgo(3).toISOString()], NOW)).toBe(100); // strings ok, junk skipped
  });
});
