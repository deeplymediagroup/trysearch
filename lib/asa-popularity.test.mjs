import { describe, it, expect } from "vitest";
import { stratifiedSample, appleGenreEnum } from "./asa-popularity.mjs";

describe("stratifiedSample", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ term: `t${i}`, pop: i + 1 }));

  it("returns everything when the pool is small", () => {
    expect(stratifiedSample(rows.slice(0, 5), 10)).toHaveLength(5);
  });

  it("spans the whole range, not just the top", () => {
    const picks = stratifiedSample(rows, 10).map((r) => r.pop);
    expect(Math.min(...picks)).toBe(1);
    expect(Math.max(...picks)).toBe(100);
    // At least one pick from the middle band — the whole point of stratifying.
    expect(picks.some((p) => p > 30 && p < 70)).toBe(true);
  });

  it("is deterministic (crawl runs must be replayable)", () => {
    expect(stratifiedSample(rows, 7)).toEqual(stratifiedSample(rows, 7));
  });

  it("never returns duplicates when rounding collides", () => {
    const tiny = rows.slice(0, 3);
    const picks = stratifiedSample(tiny, 3);
    expect(new Set(picks).size).toBe(picks.length);
  });
});

describe("appleGenreEnum", () => {
  it("maps store genre names onto Apple's enum spelling", () => {
    expect(appleGenreEnum("Health & Fitness")).toBe("HEALTH_FITNESS");
    expect(appleGenreEnum("Photo & Video")).toBe("PHOTO_VIDEO");
    expect(appleGenreEnum(null)).toBe("");
  });
});
