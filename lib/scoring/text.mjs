/**
 * Tokenising and normalisation primitives.
 *
 * Ported from aso-mindset-app/src/lib/aso.ts, which has 91 passing tests behind it.
 *
 * The load-bearing insight: the App Store indexes App Name + Subtitle + Keywords as ONE BAG
 * OF WORDS. A query matches if every word in it appears somewhere across those fields. So
 * coverage must be checked WORD-WISE against the union — never by substring on the whole
 * phrase. Apple tokenises, so "recipes" does not cover "recipe".
 */

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "my", "your", "is", "it"]);

/** Unique, lowercased, punctuation-stripped words, minus stopwords. */
export function tokens(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .normalize("NFKC")
      .toLowerCase()
      // \p{L}\p{N} rather than a-z0-9: Japanese, Korean and Cyrillic keywords are
      // first-class (01 §18.7), and [^a-z0-9] would delete them entirely.
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export const words = (term) => [...tokens(term)];

/** Canonical form for the (term_normalized, platform, country) unique key. */
export function normalizeTerm(term) {
  return String(term ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Words in a keyword, for the specificity component. Counts real words, not tokens. */
export function wordCount(term) {
  const t = normalizeTerm(term);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

/** Does this app name contain EVERY word of the query? Drives the titleMatch component. */
export function titleMatch(appName, term) {
  const termWords = words(term);
  if (!termWords.length) return false;
  const bag = tokens(appName);
  return termWords.every((w) => bag.has(w));
}

/**
 * Grapheme count, not UTF-16 code units.
 *
 * App Store character limits count graphemes, so "👨‍👩‍👧" is one character to Apple and 8 to
 * `String.length`. Getting this wrong makes every Japanese and emoji counter wrong (06 §3.6).
 */
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemeLength(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  if (!segmenter) return [...s].length; // code points beat code units even without Segmenter
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** Truncates to a grapheme budget without splitting a cluster. */
export function graphemeSlice(text, limit) {
  const s = String(text ?? "");
  if (!segmenter) return [...s].slice(0, limit).join("");
  const out = [];
  for (const seg of segmenter.segment(s)) {
    if (out.length >= limit) break;
    out.push(seg.segment);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Normalisation primitives from `aso/lib/calc.js` (02 §9.4, verbatim)
// ---------------------------------------------------------------------------

export const round2 = (val) => Math.round(val * 100) / 100;

/** Linear map of value into [1,10]. */
export function score(min, max, value) {
  let v = Math.min(max, value);
  v = Math.max(min, v);
  return round2(1 + (9 * (v - min)) / (max - min));
}

export const zScore = (max, value) => score(0, max, value);

/** Inverted: 10 at min, 1 at max. */
export function iScore(min, max, value) {
  let v = Math.min(max, value);
  v = Math.max(min, v);
  return round2(1 + (9 * (max - v)) / (max - min));
}

export const izScore = (max, value) => iScore(0, max, value);

/**
 * `aggregate(weights, values)` in that library is exactly the weighted arithmetic mean
 * whenever inputs sit in [1,10] — the min/max rescale is a no-op. So it is implemented as a
 * mean, skipping the indirection (02 §9.4).
 */
export function weightedMean(weights, values) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    num += weights[i] * values[i];
    den += weights[i];
  }
  return den === 0 ? null : round2(num / den);
}

/** Median of a numeric array. Null for an empty set — never 0. */
export function median(nums) {
  const clean = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * Rounds to N significant figures. Modelled numbers get 2: "670", never "672.4".
 * False precision on a modelled number is a lie about how much you know.
 */
export function roundToSigFigs(value, figures = 2) {
  if (value == null || !Number.isFinite(value) || value === 0) return value === 0 ? 0 : null;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (figures - 1 - magnitude);
  return Math.round(value * factor) / factor;
}
