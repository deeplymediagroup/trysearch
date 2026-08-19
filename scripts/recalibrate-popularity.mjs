/**
 * `node scripts/recalibrate-popularity.mjs`
 *
 * Two jobs the nightly metrics pass only does for keywords whose 7-day TTL has expired, done
 * here for EVERY tracked keyword at once:
 *
 *   1. Pull Apple's search-term popularity corpus (Apple Ads Platform API insights — real
 *      1–100 values, weekly) and write it onto every matching keyword.
 *   2. Re-fit and re-apply the proxy calibration, so stored popularity_estimate values sit on
 *      Apple's scale rather than the proxy's own inflated one.
 *
 * Upstream cost: one Platform API query per country. No store fetches at all.
 */
import { connect, q } from "../lib/db.mjs";
import { fitProxyCalibration, applyProxyCalibration, popularityEffective, estDownloadsAtRank1 } from "../lib/scoring/scores.mjs";
import { asaConfigured } from "../lib/stores/asa.mjs";
import { refreshAsaPopularity } from "../lib/asa-popularity.mjs";

const db = await connect();

// ---- 1. Apple's own number, for every matching iOS keyword -----------------
if (asaConfigured()) {
  const res = await refreshAsaPopularity(db, { log: console.log });
  for (const w of res.warnings) console.log(`warning: ${w}`);
  console.log(`applied Apple popularity to ${res.applied} keyword(s) from ${res.corpusRows} corpus row(s)`);
} else {
  console.log("ASA not configured — skipping the real-popularity pass.");
}

// ---- 2. Re-fit the proxy onto Apple's scale and rewrite the estimates ------
const fit = fitProxyCalibration(
  await q(
    db,
    `select popularity_proxy_raw::float as proxy, popularity::float as store from keywords
      where popularity is not null and popularity_proxy_raw is not null`,
  ),
);
console.log("proxy fit:", fit);

if (!fit.fitted) {
  console.log("not enough paired observations to calibrate — estimates left alone");
} else {
  // Always recomputed FROM THE RAW value, so running this twice is a no-op rather than a
  // second shrink. Rows with no raw value yet are left alone; the nightly metrics job records
  // one for every keyword it refreshes.
  const rows = await q(
    db,
    `select id, popularity, popularity_proxy_raw, platform from keywords where popularity_proxy_raw is not null`,
  );
  let n = 0;
  for (const r of rows) {
    const est = applyProxyCalibration(Number(r.popularity_proxy_raw), fit);
    const effective = popularityEffective({ popularity: r.popularity, popularity_estimate: est });
    await q(db, `update keywords set popularity_estimate = $2, est_downloads_rank1 = $3 where id = $1`, [
      r.id,
      est,
      estDownloadsAtRank1({ popularity: effective, platform: r.platform }),
    ]);
    n++;
  }
  console.log(`recalibrated ${n} of ${rows.length} stored estimate(s)`);
}

await db.end();
