/**
 * `node scripts/probe-asa-popularity.mjs [country] [GENRE_ENUM ...]`
 *
 * Proves the Apple Ads Platform API popularity feed end to end WITHOUT touching the
 * database: auth → insights query → prints the top rows. Run this first after (re)creating
 * API credentials in the Apple Ads console (Account Settings → API); when it prints rows,
 * the nightly crawl's popularity pass will work with the same env.
 *
 * Failures print Apple's verbatim error body — if it complains about the genre filter, pass
 * genres explicitly (e.g. `node scripts/probe-asa-popularity.mjs us HEALTH_FITNESS`) and set
 * ASA_STP_GENRES to what works.
 */
import { loadEnv } from "./env.mjs";
import { asaConfigured, asaAccessToken, searchTermPopularity, lastFullWeek } from "../lib/stores/asa.mjs";

loadEnv();

if (!asaConfigured()) {
  console.error("ASA env vars missing — need ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID, ASA_ORG_ID and ASA_PRIVATE_KEY(_FILE).");
  process.exit(1);
}

const country = process.argv[2] ?? "us";
const genres = process.argv.slice(3);

try {
  await asaAccessToken();
  console.log("1. OAuth token: OK");
} catch (err) {
  console.error(`1. OAuth token: FAILED — ${err.message}`);
  console.error("   invalid_client usually means the API key was rotated/deleted in the Apple Ads console; regenerate under Account Settings → API.");
  process.exit(1);
}

console.log(`2. Query window: week of ${lastFullWeek().start} (stepping back if not yet published)`);
const { rows, period, truncated } = await searchTermPopularity({ country, genres });
console.log(`3. ${rows.length} row(s) for ${country.toUpperCase()}, period ${period}${truncated ? " (TRUNCATED at page cap)" : ""}`);
for (const r of rows.slice(0, 15)) {
  console.log(
    `   ${String(r.rankInGenre ?? "—").padStart(4)}  pop100=${String(r.searchPopularity1to100 ?? "—").padStart(3)}  ` +
      `genrePop=${String(r.searchPopularityInGenre ?? "—").padStart(3)}  [${r.genre}]  ${r.searchTerm}`,
  );
}
if (!rows.length) process.exit(1);
console.log("\nAll good — the crawl's metrics job and scripts/recalibrate-popularity.mjs will now pick this up.");
