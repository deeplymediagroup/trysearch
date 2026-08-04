import { describe, expect, it } from "vitest";
import { verifyCandidate } from "./ai.mjs";

// The verification gate is what stands between model output and the database —
// if it breaks open, unverified AI terms get inserted as demand.
describe("verifyCandidate", () => {
  it("accepts an exact autocomplete match", () => {
    expect(verifyCandidate("daily motivation", ["daily motivation", "daily planner"])).toBe(true);
  });

  it("accepts a longer suggestion that starts with the candidate phrase", () => {
    expect(verifyCandidate("daily motivation", ["daily motivation quotes"])).toBe(true);
  });

  it("rejects a prefix-of-a-word match (no word boundary)", () => {
    expect(verifyCandidate("daily motivation", ["daily motivational"])).toBe(false);
  });

  it("rejects when autocomplete returns nothing related", () => {
    expect(verifyCandidate("stoic mindset", ["stock market", "stopwatch"])).toBe(false);
  });

  it("normalizes case, unicode width, and whitespace before comparing", () => {
    expect(verifyCandidate("  Daily　Motivation ", ["daily motivation"])).toBe(true);
  });

  it("rejects empty candidates", () => {
    expect(verifyCandidate("", ["anything"])).toBe(false);
  });
});
