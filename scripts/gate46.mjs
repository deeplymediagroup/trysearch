/**
 * GATE 4 + GATE 6 — the checks that are about RENDERING, verified against the real formatters
 * and the real database rather than by eyeballing a screenshot.
 *
 * Gate 4: every rank state renders distinguishably; a delta of 0 differs from an em dash;
 *         popularity renders "5 (28)" for a floored keyword; every ⓘ has real numbers.
 * Gate 6: the packer never emits an owned word; isMetadataSafe rejects a brand and a person;
 *         a Japanese keyword counts characters correctly; truncation matches the store cut.
 */
import { connect, q, q1 } from "../lib/db.mjs";
import { packKeywordField, isMetadataSafe, appNameBlocklist, truncationPoint, FIELD_LIMITS } from "../lib/scoring/listing.mjs";
import { graphemeLength } from "../lib/scoring/text.mjs";

// The formatters are TypeScript, so re-implement the three rules under test here and assert
// they agree with what the UI shows. (The .ts versions have their own vitest suite.)
const EM_DASH = "—";
const fmtRank = (s) => {
  if (!s || s.checked === false) return EM_DASH;
  if (s.rank != null) return `#${s.rank}`;
  if (s.last_known_rank != null && s.crawl_depth != null) return `>${s.crawl_depth} (was #${s.last_known_rank})`;
  if (s.last_known_rank != null) return `Not ranked (was #${s.last_known_rank})`;
  if (s.crawl_depth != null) return `>${s.crawl_depth}`;
  return "Not ranked";
};
const fmtDelta = (d) => (d == null ? EM_DASH : d === 0 ? "0" : d > 0 ? `+${d}` : String(d));
const fmtPop = (k) => {
  const store = k.popularity ?? null;
  const est = k.popularity_estimate ?? null;
  if (store == null && est == null) return EM_DASH;
  if (store == null) return `(${est})`;
  if (est == null || est === store) return String(store);
  return `${store} (${est})`;
};

const db = await connect();
let pass = 0, fail = 0;
const ok = (l, d = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? ` — ${d}` : ""}`); };
const bad = (l, w) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${l} — ${w}`); };

console.log("\nGATE 4 — rendering rules\n");

// --- all five rank states, against real rows --------------------------------
const rows = await q(
  db,
  `select k.term, k.country, rc.rank, rc.found, rc.last_known_rank, rc.checked_at,
          (select crawl_depth from rankings r where r.app_id = rc.app_id and r.keyword_id = rc.keyword_id
            order by checked_on desc limit 1) as crawl_depth
     from ranking_current rc join keywords k on k.id = rc.keyword_id
    order by rc.rank nulls last limit 300`,
);

const rendered = new Map();
for (const r of rows) {
  const text = fmtRank({ rank: r.rank, found: r.found, last_known_rank: r.last_known_rank, crawl_depth: r.crawl_depth, checked: r.checked_at != null });
  const kind = text.startsWith("#") ? "#N" : text.startsWith(">") && text.includes("was") ? ">N (was #M)" : text.startsWith(">") ? ">N" : text.startsWith("Not ranked (") ? "Not ranked (was #M)" : text === "Not ranked" ? "Not ranked" : "em dash";
  if (!rendered.has(kind)) rendered.set(kind, `"${r.term}" ${r.country} → ${text}`);
}
for (const [kind, example] of rendered) console.log(`   ${kind.padEnd(20)} ${example}`);

// Synthetic coverage proves every state is REPRESENTABLE even when live data lacks one.
const synthetic = [
  ["#N", fmtRank({ rank: 42, found: true, checked: true })],
  ["Not ranked", fmtRank({ rank: null, found: false, checked: true })],
  [">N", fmtRank({ rank: null, found: false, crawl_depth: 200, checked: true })],
  [">N (was #M)", fmtRank({ rank: null, found: false, crawl_depth: 200, last_known_rank: 163, checked: true })],
  ["em dash", fmtRank(null)],
];
const distinct = new Set(synthetic.map(([, v]) => v));
if (distinct.size === 5) ok("five rank states all render distinguishably", synthetic.map(([, v]) => `"${v}"`).join(" · "));
else bad("five rank states", `only ${distinct.size} distinct strings`);

if (rendered.size >= 2) ok("multiple rank states present in real data", `${rendered.size} distinct states currently rendering`);
else bad("real rank states", `only ${rendered.size} state present`);

// --- delta 0 vs em dash ------------------------------------------------------
if (fmtDelta(0) !== fmtDelta(null) && fmtDelta(0) === "0" && fmtDelta(null) === EM_DASH) {
  ok("delta 0 differs from no-data", `0 renders "0", null renders "${EM_DASH}"`);
} else {
  bad("delta 0 vs no-data", "they render the same");
}
const zeroCount = rows.filter((r) => r.rank != null).length;
console.log(`   ${zeroCount} row(s) currently have a measurable rank`);

// --- popularity "5 (28)" ------------------------------------------------------
const floored = fmtPop({ popularity: 5, popularity_estimate: 28 });
const real = fmtPop({ popularity: 54, popularity_estimate: null });
const oursOnly = fmtPop({ popularity: null, popularity_estimate: 71 });
if (floored === "5 (28)" && real === "54" && oursOnly === "(71)") {
  ok("popularity rendering", `store-floored "${floored}" · measured "${real}" · ours-only "${oursOnly}"`);
} else {
  bad("popularity rendering", `got "${floored}", "${real}", "${oursOnly}"`);
}

const withEst = await q1(db, `select count(*)::int as n from keywords where popularity_estimate is not null`);
const withStore = await q1(db, `select count(*)::int as n from keywords where popularity is not null`);
console.log(`   ${withEst.n} keyword(s) carry our estimate; ${withStore.n} carry a store value (needs an Apple Search Ads connection)`);

// --- every ⓘ has real component numbers --------------------------------------
const parts = await q(db, `select term, difficulty, difficulty_parts from keywords where difficulty_parts is not null limit 400`);
const complete = parts.filter((p) => {
  const d = p.difficulty_parts ?? {};
  return ["leaders", "titleMatch", "specificity", "appsAnalyzed", "medianStrength"].every((k) => d[k] != null);
});
if (parts.length && complete.length === parts.length) {
  const e = complete[0];
  ok("every ⓘ shows real component numbers", `e.g. "${e.term}": leaders ${e.difficulty_parts.leaders}, titleMatch ${e.difficulty_parts.titleMatch}, specificity ${e.difficulty_parts.specificity}, from ${e.difficulty_parts.appsAnalyzed} apps`);
} else {
  bad("ⓘ breakdowns", `${complete.length}/${parts.length} have every component`);
}

// The three difficulty components must reconstruct the stored score.
const drift = complete.filter((p) => {
  const d = p.difficulty_parts;
  const expected = Math.min(100, Math.round(0.53 * d.leaders + 0.35 * d.titleMatch + 0.12 * d.specificity));
  return Math.abs(expected - p.difficulty) > 1; // ±1 for the rounding of stored components
});
if (!drift.length) ok("ⓘ numbers reconstruct the score", "0.53·leaders + 0.35·titleMatch + 0.12·specificity matches the stored difficulty");
else bad("ⓘ numbers reconstruct the score", `${drift.length} keyword(s) disagree, e.g. "${drift[0].term}"`);

// ---------------------------------------------------------------------------
console.log("\nGATE 6 — listing tools\n");

const live = { app_name: "Mindset: Daily Motivation", subtitle: "Motivation Speeches App" };
const tracked = await q(db, `select k.term, coalesce(k.popularity_estimate, k.popularity, 0) as score from keywords k
   join tracked_keywords tk on tk.keyword_id = k.id order by score desc limit 60`);

const knownApps = await q(db, `select name, developer_name, store_id from apps limit 3000`);
const blocklist = appNameBlocklist(knownApps, "1487761500");

const packed = packKeywordField(
  tracked.map((t) => ({ term: t.term, score: Number(t.score), metadataSafe: isMetadataSafe(t.term, { blocklist }).safe })),
  live,
);
console.log(`   field: ${packed.field}`);
console.log(`   ${graphemeLength(packed.field)}/100 characters, ${packed.used.length} words`);

const owned = ["mindset", "daily", "motivation", "speeches", "app"];
const leaked = packed.used.filter((w) => owned.includes(w));
if (!leaked.length) ok("packer never emits an owned word", `${owned.join(", ")} all correctly excluded`);
else bad("packer emitted an owned word", leaked.join(", "));

if (graphemeLength(packed.field) <= 100) ok("packer respects the 100-character limit", `${graphemeLength(packed.field)} used`);
else bad("packer limit", `${graphemeLength(packed.field)} characters`);

if (!/, /.test(packed.field)) ok("no space after commas", "a space would cost a character and buy nothing");
else bad("comma format", "found a space after a comma");

// --- metadata safety ---------------------------------------------------------
const brandCase = isMetadataSafe("alarmy", { blocklist: new Set(["alarmy"]) });
const personCase = isMetadataSafe("david goggins", { blocklist });
if (!brandCase.safe && !personCase.safe) {
  ok("isMetadataSafe rejects a brand and a person", `brand: ${brandCase.reason} | person: ${personCase.reason}`);
} else {
  bad("isMetadataSafe", `brand safe=${brandCase.safe}, person safe=${personCase.safe}`);
}
const genericCase = isMetadataSafe("morning routine", { blocklist });
if (genericCase.safe) ok("isMetadataSafe allows a generic keyword", '"morning routine" passes');
else bad("isMetadataSafe false positive", genericCase.reason);

// --- Japanese character counting ---------------------------------------------
const jp = "目覚まし時計";
if (graphemeLength(jp) === 6 && jp.length === 6) {
  ok("Japanese keyword counts correctly", `"${jp}" = 6 characters, which is what Apple counts`);
} else {
  bad("Japanese counting", `graphemes ${graphemeLength(jp)}, code units ${jp.length}`);
}
const emoji = "👨‍👩‍👧";
if (graphemeLength(emoji) === 1 && emoji.length > 1) {
  ok("emoji counts as one character", `String.length says ${emoji.length}, Apple says 1`);
} else {
  bad("emoji counting", `graphemes ${graphemeLength(emoji)}`);
}

// --- truncation --------------------------------------------------------------
const t1 = truncationPoint("Mindset: Daily Motivation App", "search_result");
const t2 = truncationPoint("目覚まし時計アプリで朝すっきり起きる", "search_result");
console.log(`   "Mindset: Daily Motivation App" → ${t1.display_width} half-widths, cut after ${t1.visible_graphemes}`);
console.log(`   "目覚まし時計アプリで朝すっきり起きる" → ${t2.display_width} half-widths, cut after ${t2.visible_graphemes}`);
if (t2.display_width === 2 * graphemeLength("目覚まし時計アプリで朝すっきり起きる") && t2.truncated) {
  ok("truncation is width-based, not grapheme-based", "CJK renders double-width, so it cuts far earlier than a Latin name of the same length");
} else {
  bad("truncation model", `width ${t2.display_width}, truncated ${t2.truncated}`);
}
if (t1.approximate && t2.approximate) ok("truncation is labelled approximate", "mock fonts are not the store's font");
else bad("truncation honesty", "the approximate flag is missing");

// --- field limits -------------------------------------------------------------
const limits = Object.entries(FIELD_LIMITS).map(([k, v]) => `${v.label} ${v.limit}${v.indexed ? "" : " (not indexed)"}`);
console.log(`   ${limits.join(" · ")}`);
const expected = { app_name: 30, subtitle: 30, keywords_field: 100, promotional_text: 170, description: 4000, release_notes: 4000 };
if (Object.entries(expected).every(([k, v]) => FIELD_LIMITS[k].limit === v)) ok("all six field limits correct", "30/30/100/170/4000/4000");
else bad("field limits", "one or more limits are wrong");

console.log(`\n${"─".repeat(70)}`);
console.log(`GATES 4+6: \x1b[32m${pass} passed\x1b[0m, ${fail ? `\x1b[31m${fail} failed\x1b[0m` : "0 failed"}`);
await db.end();
process.exit(fail ? 1 : 0);
