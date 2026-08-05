/**
 * `node scripts/recalibrate-popularity.mjs`
 *
 * Two jobs the nightly metrics pass only does for keywords whose 7-day TTL has expired, done
 * here for EVERY tracked keyword at once:
 *
 *   1. Apply Apple's real Search Popularity from the Search Ads SOV report. One report per
 *      country (quota is 10/day) covers every term Apple links to the app, so there is no
 *      reason to hand it out only to keywords that happen to be stale.
 *   2. Re-fit and re-apply the proxy calibration, so stored popularity_estimate values sit on
 *      Apple's scale rather than the proxy's own inflated one.
 *
 * Upstream cost: at most one ASA report per country. No store fetches at all.
 */
import { connect, q } from "../lib/db.mjs";
import { fitProxyCalibration, applyProxyCalibration, popularityEffective, estDownloadsAtRank1 } from "../lib/scoring/scores.mjs";
import { asaConfigured, searchPopularity, SAP_BUCKET_TO_POPULARITY } from "../lib/stores/asa.mjs";

const db = await connect();

// ---- 1. Apple's own number, for every tracked iOS keyword ------------------
let applied = 0;
if (asaConfigured()) {
  const own = await q(
    db,
    `select distinct a.store_id from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.role = 'own' and a.platform = 'ios' and ta.is_active`,
  );
  const countries = await q(
    db,
    `select distinct k.country from tracked_keywords tk join keywords k on k.id = tk.keyword_id
      where k.platform = 'ios'`,
  );

  for (const { country } of countries) {
    for (const { store_id } of own) {
      // ASA allows 10 custom reports a day. One country hitting the quota must not abandon the
      // calibration pass that follows — that work needs no upstream calls at all.
      let sap;
      try {
        sap = await searchPopularity({ adamId: store_id, country });
      } catch (err) {
        console.log(`asa sov ${country}: skipped (${err.message.slice(0, 80)})`);
        continue;
      }
      console.log(`asa sov ${country}: ${sap.size} term(s) with real popularity`);
      if (!sap.size) continue;
      const terms = await q(
        db,
        `select k.id, k.term_normalized from tracked_keywords tk join keywords k on k.id = tk.keyword_id
          where k.platform = 'ios' and k.country = $1`,
        [country],
      );
      for (const t of terms) {
        const bucket = sap.get(t.term_normalized);
        if (bucket == null) continue;
        await q(db, `update keywords set popularity = $2, popularity_source = 'store' where id = $1`, [
          t.id,
          SAP_BUCKET_TO_POPULARITY[bucket],
        ]);
        applied++;
      }
    }
  }
} else {
  console.log("ASA not configured — skipping the real-popularity pass.");
}
console.log(`applied Apple popularity to ${applied} keyword(s)`);

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
