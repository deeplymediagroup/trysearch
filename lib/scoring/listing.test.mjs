/**
 * GATE 6 checks live here alongside the Gate 2 checklist items for the listing tools,
 * because the packer and the safety checker are pure code and testable from day one.
 */
import { describe, it, expect } from "vitest";
import {
  packKeywordField,
  isMetadataSafe,
  appNameBlocklist,
  coverageOf,
  truncationPoint,
  FIELD_LIMITS,
  looksLikeAppTitle,
  PERSON_NAMES,
} from "./listing.mjs";
import { graphemeLength } from "./text.mjs";

const live = { app_name: "Mindset: Daily Motivation", subtitle: "Motivation Speeches App" };

describe("packKeywordField", () => {
  it("[§13] never emits a word already in App Name or Subtitle", () => {
    const candidates = [
      { term: "daily motivation", score: 90 }, // both words already owned
      { term: "discipline quotes", score: 80 },
      { term: "mindset speeches", score: 70 }, // both owned
      { term: "gym affirmations", score: 60 },
    ];
    const { field, used } = packKeywordField(candidates, live);

    for (const owned of ["mindset", "daily", "motivation", "speeches", "app"]) {
      expect(used).not.toContain(owned);
      // And not present anywhere in the packed string either.
      expect(field.split(",")).not.toContain(owned);
    }
    expect(used).toContain("discipline");
    expect(used).toContain("affirmations");
  });

  it("stays inside 100 characters and uses commas with NO spaces", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => ({ term: `uniqueword${i} phrase${i}`, score: 100 - i }));
    const { field, length, skipped } = packKeywordField(candidates, live);

    expect(graphemeLength(field)).toBeLessThanOrEqual(100);
    expect(length).toBeLessThanOrEqual(100);
    expect(field).not.toMatch(/, /); // a space after a comma costs a character and buys nothing
    expect(skipped.length).toBeGreaterThan(0); // it genuinely ran out of budget
  });

  it("orders words by the value of the keywords they unlock", () => {
    const { used } = packKeywordField(
      [
        { term: "lowvalue", score: 10 },
        { term: "highvalue", score: 99 },
        { term: "midvalue", score: 50 },
      ],
      live,
    );
    expect(used).toEqual(["highvalue", "midvalue", "lowvalue"]);
  });

  it("returns a `because` map justifying every character", () => {
    const { because, used } = packKeywordField([{ term: "discipline quotes", score: 80 }], live);
    for (const word of used) {
      expect(because[word]).toBeTruthy();
      expect(because[word].length).toBeGreaterThan(0);
    }
    expect(because.discipline).toContain("discipline quotes");
  });

  it("refuses to pack a term flagged unsafe, even if it scores highest", () => {
    const { used } = packKeywordField(
      [
        { term: "goggins motivation", score: 100, metadataSafe: false },
        { term: "discipline", score: 10 },
      ],
      live,
    );
    expect(used).not.toContain("goggins");
    expect(used).toContain("discipline");
  });

  it("honours an operator exclusion list — the generator is a proposal, not an oracle", () => {
    const { used } = packKeywordField([{ term: "discipline grind", score: 80 }], live, 100, new Set(["grind"]));
    expect(used).toContain("discipline");
    expect(used).not.toContain("grind");
  });
});

describe("isMetadataSafe", () => {
  const blocklist = appNameBlocklist(
    [
      { store_id: "1", name: "Motivation - Daily quotes", developer_name: "Monkey Taps" },
      { store_id: "2", name: "Alarmy", developer_name: "Delight Room" },
      { store_id: "999", name: "Mindset: Daily Motivation", developer_name: "Deeply Media" }, // ours
    ],
    "999",
  );

  it("[§13] rejects a known competitor brand", () => {
    const r = isMetadataSafe("alarmy", { blocklist });
    expect(r.safe).toBe(false);
    // Caught by the exact-name rule, since "Alarmy" IS the whole app name.
    expect(r.reason).toContain("Exactly matches");

    // A brand appearing as one word inside a longer phrase is caught by the brand-word rule.
    const phrase = isMetadataSafe("alarmy alternative", { blocklist });
    expect(phrase.safe).toBe(false);
    expect(phrase.reason).toContain("brand");
  });

  it("[§13] rejects a known person name", () => {
    expect(isMetadataSafe("david goggins", { blocklist }).safe).toBe(false);
    expect(isMetadataSafe("goggins motivation", { blocklist }).safe).toBe(false);
    expect(isMetadataSafe("huberman", { blocklist }).safe).toBe(false);
    // Every name in the curated list must be caught, not just the ones I remembered.
    for (const p of PERSON_NAMES) expect(isMetadataSafe(p, { blocklist }).safe).toBe(false);
  });

  it("rejects a publisher name", () => {
    expect(isMetadataSafe("monkey taps", { blocklist }).safe).toBe(false);
  });

  it("does NOT block our own app name", () => {
    // Our own brand is a legitimate (and important) keyword to own.
    expect(isMetadataSafe("mindset", { blocklist }).safe).toBe(true);
  });

  it("allows ordinary generic keywords", () => {
    for (const term of ["motivational quotes", "morning routine", "discipline tracker", "wake up early"]) {
      expect(isMetadataSafe(term, { blocklist }).safe).toBe(true);
    }
  });

  it("still allows a descriptive phrase that happens to be an app's exact name, with a caution", () => {
    // Somebody has shipped an app called "Morning Routine". That does not make the phrase
    // theirs — blocking it would quietly cost a legitimate keyword.
    const named = appNameBlocklist([{ store_id: "7", name: "Morning Routine", developer_name: "Someone" }]);
    const r = isMetadataSafe("morning routine", { blocklist: named });
    expect(r.safe).toBe(true);
    expect(r.caution).toContain("purely descriptive");
  });

  it("still blocks an app name carrying a distinctive token", () => {
    const named = appNameBlocklist([{ store_id: "8", name: "Alarmy Morning", developer_name: "Delight Room" }]);
    // "alarmy" is not a category word, so the phrase stays blocked.
    expect(isMetadataSafe("alarmy morning", { blocklist: named }).safe).toBe(false);
  });

  it("gives a reason for every rejection so the UI can fail loudly", () => {
    const r = isMetadataSafe("alarmy", { blocklist });
    expect(r.reason).toBeTruthy();
    expect(isMetadataSafe("", { blocklist }).safe).toBe(false);
  });

  it("honours per-workspace extra brand terms", () => {
    expect(isMetadataSafe("somerival", { extraBrandTerms: new Set(["somerival"]) }).safe).toBe(false);
  });
});

describe("appNameBlocklist", () => {
  it("blocks the full title AND the bare leading brand", () => {
    const b = appNameBlocklist([{ store_id: "1", name: "Forge: Daily Mindset Quotes" }]);
    expect(b.has("forge daily mindset quotes")).toBe(true);
    expect(b.has("forge")).toBe(true);
  });

  it("recognises app titles by their punctuation", () => {
    expect(looksLikeAppTitle("Forge: Daily Mindset Quotes")).toBe(true);
    expect(looksLikeAppTitle("Habit – Tracker")).toBe(true);
    expect(looksLikeAppTitle("motivational quotes")).toBe(false);
  });
});

describe("coverageOf", () => {
  it("checks word-wise across the indexed fields, not by substring", () => {
    const fields = { app_name: "Mindset", subtitle: "Daily Motivation", keywords_field: "discipline,grind" };
    expect(coverageOf("daily discipline", fields).covered).toBe(true);
    expect(coverageOf("sleep sounds", fields).covered).toBe(false);
    expect(coverageOf("sleep sounds", fields).missing).toEqual(["sleep", "sounds"]);
  });

  it("reports the description separately — it is Google's surface, not Apple's", () => {
    const fields = { app_name: "Mindset", subtitle: "Daily", keywords_field: "", description: "meditation and calm" };
    const c = coverageOf("meditation", fields);
    expect(c.fields).toEqual(["description"]);
    // Apple does not index the description, so description-only is NOT covered.
    expect(c.covered).toBe(false);
  });

  it("flags coverage as unverified when the live keyword field is unknown", () => {
    // The 100-char field is never readable from a public endpoint, so without App Store
    // Connect this is a lower bound rather than a fact.
    expect(coverageOf("x", { app_name: "A", subtitle: "B", keywords_field: null }).unverified).toBe(true);
    expect(coverageOf("x", { app_name: "A", subtitle: "B", keywords_field: "" }).unverified).toBe(false);
  });
});

describe("field limits and truncation", () => {
  it("has the six App Store limits with correct indexing flags", () => {
    expect(FIELD_LIMITS.app_name).toMatchObject({ limit: 30, indexed: true });
    expect(FIELD_LIMITS.subtitle).toMatchObject({ limit: 30, indexed: true });
    expect(FIELD_LIMITS.keywords_field).toMatchObject({ limit: 100, indexed: true });
    expect(FIELD_LIMITS.promotional_text).toMatchObject({ limit: 170, indexed: false });
    expect(FIELD_LIMITS.description).toMatchObject({ limit: 4000, indexed: false });
    expect(FIELD_LIMITS.release_notes).toMatchObject({ limit: 4000, indexed: false });
  });

  it("[§13] counts a Japanese keyword's characters correctly", () => {
    // 6 graphemes, but 18 bytes — a byte or code-unit count would report the wrong budget.
    expect(graphemeLength("目覚まし時計")).toBe(6);
    expect(graphemeLength("目覚まし時計アプリで朝すっきり起きる")).toBe(18);

    // 18 graphemes fits Apple's 30-character LIMIT, but each renders double-width, so it is
    // 36 half-widths and gets visually cut around the 11th character. Limit and truncation
    // are two different questions and the tool must not conflate them.
    const t = truncationPoint("目覚まし時計アプリで朝すっきり起きる", "search_result");
    expect(t.display_width).toBe(36);
    expect(t.truncated).toBe(true);
    expect(t.visible_graphemes).toBe(11);
  });

  it("cuts a Latin name later than a Japanese one of the same grapheme count", () => {
    const latin = truncationPoint("abcdefghijklmnopqr", "search_result"); // 18 half-widths
    const cjk = truncationPoint("目覚まし時計アプリで朝すっきり起きる", "search_result"); // 36
    expect(latin.truncated).toBe(false);
    expect(cjk.truncated).toBe(true);
  });

  it("marks the truncation estimate as approximate, because mock fonts are not the store's", () => {
    const t = truncationPoint("A very long app name that will certainly be cut off");
    expect(t.truncated).toBe(true);
    expect(t.approximate).toBe(true);
    expect(t.hidden_graphemes).toBeGreaterThan(0);
  });

  it("does not flag a short name as truncated", () => {
    expect(truncationPoint("Mindset").truncated).toBe(false);
  });
});
