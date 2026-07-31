/**
 * The listing tools: keyword-field packer, metadata safety, and coverage.
 *
 * Ported from aso-mindset-app/src/lib/aso.ts (packKeywordField, isMetadataSafe,
 * appNameBlocklist, coverageOf) and generalised off that app's static-JSON shape.
 *
 * These are PURE CODE and genuinely useful with no AI at all — which is why 09-BUILD-PLAN
 * says to ship them before wiring any generation.
 */
import { tokens, words, graphemeLength } from "./text.mjs";

/** App Store field limits, in GRAPHEMES. `indexed` drives the badge in the UI. */
export const FIELD_LIMITS = {
  app_name: { limit: 30, indexed: true, label: "App Name" },
  subtitle: { limit: 30, indexed: true, label: "Subtitle" },
  keywords_field: { limit: 100, indexed: true, label: "Keywords" },
  promotional_text: { limit: 170, indexed: false, label: "Promotional Text" },
  description: { limit: 4000, indexed: false, label: "Description" },
  release_notes: { limit: 4000, indexed: false, label: "What's New" },
};

/**
 * Builds the 100-character App Store keyword field.
 *
 * Apple indexes App Name + Subtitle + Keywords as ONE BAG OF WORDS, so:
 *   - never repeat a word already in the App Name or Subtitle — it buys nothing
 *   - split on commas with NO space after them (a space costs a character and buys nothing)
 *   - order candidate words by the value of the keywords they unlock
 *   - word-wise coverage, never substring: Apple tokenises, so "recipes" ≠ "recipe"
 *
 * Returns a `because` map justifying every character, because "why is this word here" is the
 * question users actually have.
 */
export function packKeywordField(candidates, live, limit = FIELD_LIMITS.keywords_field.limit, exclude = new Set()) {
  const owned = new Set([...tokens(live?.app_name ?? live?.name), ...tokens(live?.subtitle)]);

  const best = new Map(); // word → highest score of any keyword it unlocks
  const unlockedBy = new Map(); // word → the keywords it unlocks

  for (const { term, score = 0, metadataSafe } of [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (metadataSafe === false) continue; // never leak a brand or person name into an indexed field
    for (const word of words(term)) {
      if (owned.has(word) || exclude.has(word)) continue;
      if (!best.has(word) || score > best.get(word)) best.set(word, score);
      const list = unlockedBy.get(word) ?? [];
      // Dedupe: the same term is usually tracked in several countries, and the keyword FIELD
      // is per-locale, so "habit tracker, habit tracker" is noise in the justification.
      if (list.length < 3 && !list.includes(term)) list.push(term);
      unlockedBy.set(word, list);
    }
  }

  const ordered = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
  const used = [];
  const skipped = [];
  let length = 0;

  for (const word of ordered) {
    const cost = graphemeLength(word) + (used.length ? 1 : 0); // the comma separator
    if (length + cost <= limit) {
      used.push(word);
      length += cost;
    } else {
      skipped.push(word);
    }
  }

  return {
    field: used.join(","),
    used,
    skipped,
    unlocked: [...new Set(used.flatMap((w) => unlockedBy.get(w) ?? []))],
    because: Object.fromEntries([...unlockedBy].filter(([w]) => used.includes(w))),
    length,
    limit,
  };
}

/**
 * People whose names show up as high-value queries in this category.
 *
 * Apple REJECTS listings containing unauthorised third-party names, so these may legitimately
 * be BOUGHT as Search Ads keywords but must never go in indexed metadata. Ported from the
 * curated list in aso.ts — getting this wrong is worse than missing an opportunity.
 */
export const PERSON_NAMES = [
  "goggins", "david goggins", "jordan peterson", "peterson", "jocko", "willink", "tony robbins",
  "robbins", "les brown", "eric thomas", "inky johnson", "denzel", "kobe", "ed mylett",
  "andrew huberman", "huberman", "joe rogan", "rogan", "gary vee", "vaynerchuk", "simon sinek",
];

const normalise = (text) => words(text).join(" ");

/** App titles carry punctuation that real search queries do not. */
export const looksLikeAppTitle = (term) => /[:|]|\s[-–—]\s/.test(term);

/**
 * Builds an EXACT blocklist from the real app names already collected in SERP data.
 *
 * Autocomplete is dominated by other apps' titles ("forge: daily mindset quotes"). Since the
 * crawl already stores ~1,200 real app names, an exact blocklist is available for free — far
 * better than guessing at stopwords.
 *
 * @param {Array<{name?: string|null, developer_name?: string|null, store_id?: string|null}>} apps
 * @param {string|null} [ownStoreId]  our own app, which must NOT block itself
 */
export function appNameBlocklist(apps = [], ownStoreId = null) {
  const out = new Set();
  for (const app of apps) {
    if (!app?.name) continue;
    if (ownStoreId && String(app.store_id) === String(ownStoreId)) continue;
    out.add(normalise(app.name));
    // "Forge: Daily Mindset Quotes" also blocks the bare brand "forge".
    const brand = normalise(String(app.name).split(/[:\-–—|(]/)[0]);
    if (brand) out.add(brand);
    // Publisher names surface too ("mindset motivation inc.") and are not queries we can win.
    if (app.developer_name) out.add(normalise(app.developer_name));
  }
  return out;
}

/**
 * May this term legally go in App Store metadata?
 *
 * Competitor app names, publisher names and third-party personal names are all off-limits —
 * Apple rejects for it — even when paid data proves the query converts. Anything that looks
 * like someone else's brand is treated as unsafe, and the UI must FAIL LOUDLY rather than
 * generating a listing that gets rejected.
 *
 * @returns {{safe: boolean, reason: string|null}}
 */
export function isMetadataSafe(term, { blocklist = new Set(), extraBrandTerms = new Set() } = {}) {
  const key = normalise(term);
  if (!key) return { safe: false, reason: "Empty after normalisation." };

  const termWords = words(term);

  const person = PERSON_NAMES.find((p) => key === normalise(p) || termWords.includes(normalise(p)));
  if (person) return { safe: false, reason: `"${person}" is a person's name — Apple rejects unauthorised third-party names in metadata.` };

  if (extraBrandTerms.has(key)) return { safe: false, reason: "Marked as a brand term for this workspace." };

  if (blocklist.has(key)) {
    // An exact match against an app name is NOT automatically a brand problem. Plenty of apps
    // are called plainly descriptive things ("Morning Routine", "Habit Tracker"), and those
    // phrases are ordinary search terms that nobody owns. Blocking them would quietly cost
    // real keywords, which is its own kind of failure.
    //
    // So: block only when the phrase carries a DISTINCTIVE token. If every word is a common
    // category word, allow it and flag it for review instead.
    if (termWords.every((w) => GENERIC_WORDS.has(w))) {
      return {
        safe: true,
        reason: null,
        caution: "An app is named exactly this, but the phrase is purely descriptive — ordinary search terms are not brands. Worth a glance before you ship it.",
      };
    }
    return { safe: false, reason: "Exactly matches another app's name or publisher." };
  }

  // A single distinctive word that is some other app's whole brand ("peptalk", "alarmy").
  const brandWord = termWords.find((w) => w.length > 4 && !GENERIC_WORDS.has(w) && blocklist.has(w));
  if (brandWord) return { safe: false, reason: `"${brandWord}" is another app's brand name.` };

  return { safe: true, reason: null };
}

/**
 * Common category and English words that cannot function as anyone's exclusive brand.
 *
 * Deliberately conservative and hand-kept: a word missing from this list only means a term
 * gets flagged for review, which is the safe direction to fail in. Adapted from the category
 * lexicon in Brandon's aso-research.mjs.
 */
const GENERIC_WORDS = new Set(
  `motivation motivational motivate motivated discipline disciplined self improvement improve mindset alarm alarms
   wake waking morning routine routines evening night affirmation affirmations positive positivity confidence
   confident focus focused habit habits tracker tracking consistency mental toughness tough grind grit willpower
   speech speeches speaker quote quotes inspiration inspirational inspire success successful achieve goal goals
   stoic stoicism meditation meditate mindful mindfulness gratitude journal journaling breathe breathing calm
   sleep sleeping relax relaxing timer clock daily everyday weekly reminder reminders widget widgets streak
   streaks planner plan planning workout fitness gym exercise health healthy diet food recipe recipes water
   study studying productivity productive todo list notes note money budget finance saving invest weather
   news music audio video photo photos camera edit editor game games kids baby pet dog cat travel map maps
   translate translator scanner scan pdf app apps free pro plus premium best top new daily quick easy simple
   smart my your the and for with without your you life live living day days time times year years`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Word-wise coverage of a keyword against the listing fields.
 *
 * Apple ranks on App Name + Subtitle + Keywords. The description is GOOGLE's surface, so it
 * is reported separately and never conflated with the two stores' different indexing rules.
 */
export function coverageOf(term, live = {}) {
  const bag = {
    app_name: tokens(live.app_name ?? live.name),
    subtitle: tokens(live.subtitle),
    keywords_field: tokens(live.keywords_field),
    description: tokens(live.description),
  };
  const indexed = ["app_name", "subtitle", "keywords_field"];

  const missing = [];
  const fields = new Set();

  for (const word of words(term)) {
    const hit = indexed.find((f) => bag[f].has(word));
    if (hit) fields.add(hit);
    else if (bag.description.has(word)) fields.add("description");
    else missing.push(word);
  }

  return {
    covered: missing.length === 0 && [...fields].some((f) => f !== "description"),
    fields: [...fields],
    missing,
    // We can never READ the live keywords field from a public endpoint, so if the workspace
    // has not supplied it via App Store Connect, coverage is a lower bound rather than a fact.
    unverified: live.keywords_field == null,
  };
}

/**
 * Where the store visually cuts App Name and Subtitle in the search-results placement.
 *
 * The words past the cut still get INDEXED — they are just never read by a human in this
 * placement, which is the distinction the UI has to make clear.
 *
 * Approximate by design: mock fonts are not the store's font, so a borderline cut is
 * borderline. Ship that caveat alongside the warning.
 */
export function truncationPoint(text, placement = "search_result") {
  // Budgets are in HALF-WIDTH UNITS, not graphemes. This distinction is the whole point:
  // Apple's 30-character LIMIT counts graphemes, but what gets visually cut depends on how
  // wide those graphemes render. "目覚まし時計アプリで朝すっきり起きる" is 18 graphemes and
  // fits well inside a 30-character limit, yet it is 36 half-widths and overflows the search
  // placement long before a 30-character Latin name would.
  const budgets = { search_result: 23, product_page: 30 };
  const budget = budgets[placement] ?? 30;

  const clusters = graphemeClusters(text);
  let width = 0;
  let visible = 0;
  for (const g of clusters) {
    const w = displayWidth(g);
    if (width + w > budget) break;
    width += w;
    visible++;
  }

  return {
    truncated: visible < clusters.length,
    visible_graphemes: visible,
    hidden_graphemes: clusters.length - visible,
    display_width: clusters.reduce((s, g) => s + displayWidth(g), 0),
    budget_half_widths: budget,
    // Mock fonts are not the store's font, so a borderline cut is genuinely borderline.
    approximate: true,
  };
}

function graphemeClusters(text) {
  const s = String(text ?? "");
  if (typeof Intl === "undefined" || !Intl.Segmenter) return [...s];
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment);
}

/**
 * Half-width units for one grapheme cluster. CJK ideographs, kana, Hangul and emoji render
 * double-width in the store's UI; Latin renders single.
 */
function displayWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (cp == null) return 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff); // emoji
  return wide ? 2 : 1;
}
