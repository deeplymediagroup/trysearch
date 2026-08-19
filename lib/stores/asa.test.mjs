import { describe, it, expect } from "vitest";
import { lastFullWeek } from "./asa.mjs";

// The weekly dataset is keyed Sun–Sat in UTC; an off-by-one window silently fetches nothing,
// so the boundary days each get a case.
describe("lastFullWeek", () => {
  it("mid-week returns the previous Sun–Sat", () => {
    expect(lastFullWeek(new Date("2026-08-19T12:00:00Z"))).toEqual({ start: "2026-08-09", end: "2026-08-15" }); // Wed
  });
  it("Sunday returns the week that just ended", () => {
    expect(lastFullWeek(new Date("2026-08-16T00:00:00Z"))).toEqual({ start: "2026-08-09", end: "2026-08-15" });
  });
  it("Saturday excludes the still-running week", () => {
    expect(lastFullWeek(new Date("2026-08-15T23:00:00Z"))).toEqual({ start: "2026-08-02", end: "2026-08-08" });
  });
  it("weeksBack steps whole weeks", () => {
    expect(lastFullWeek(new Date("2026-08-19T12:00:00Z"), 1)).toEqual({ start: "2026-08-02", end: "2026-08-08" });
  });
});
