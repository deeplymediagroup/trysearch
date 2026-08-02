"use server";

/**
 * On-demand revenue estimate for ANY app, tracked or not — the "size up a competitor before
 * deciding to track it" box on /revenue.
 *
 * Computes live and caches the result in revenue_estimates like the crawl job does, so the
 * second person to ask the same question pays nothing. Rows written here are indistinguishable
 * from crawled ones by design: same table, same scoring function, one source of truth.
 */
import { revalidatePath } from "next/cache";
import { q, q1 } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { upsertApp } from "@/lib/db.mjs";
import { parseAppRef } from "@/lib/stores/resolve.mjs";
import { appleLookup, appleSearch, appleInAppPurchases } from "@/lib/stores/apple.mjs";
import { playAppDetail, playSearchRanked } from "@/lib/stores/play.mjs";
import { revenueEstimate } from "@/lib/scoring/scores.mjs";

const dbShim = { query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) };

let sinkReady = false;
function withSink() {
  if (sinkReady) return;
  setFetchSink(dbShim);
  sinkReady = true;
}

export type RevenueLookup = {
  name: string;
  store: "ios" | "android";
  store_id: string;
  model: string;
  confidence: string;
  display: string;
  monthly_usd_low: number | null;
  monthly_usd_high: number | null;
  factors: string[];
  iaps: { name: string; price_cents: number; period: string | null; annualised_cents: number | null }[];
};

export async function lookupRevenue(input: string): Promise<{ result?: RevenueLookup; error?: string }> {
  const ref = parseAppRef(input);
  if (!ref) return { error: "Enter an app name, store link, id or package name." };

  withSink();
  // The US storefront always: the estimate is denominated in USD, so its price inputs must be.
  const country = "us";

  try {
    // Resolve to exactly one app.
    let store: "ios" | "android";
    let storeId: string;
    if (ref.id) {
      store = ref.store as "ios" | "android";
      storeId = ref.id;
    } else {
      const term = ref.query ?? ref.bundle ?? "";
      const [ios, android] = await Promise.all([
        appleSearch(term, country, 1).catch(() => []),
        playSearchRanked(term, country).catch(() => []),
      ]);
      const pick = (ios as any[])[0] ?? (android as any[])[0];
      if (!pick) return { error: `Nothing on either store matched "${term}".` };
      store = (ios as any[])[0] ? "ios" : "android";
      storeId = String(pick.store_id);
    }

    let meta: any;
    let iaps: any[] = [];
    let realInstalls: number | null = null;
    let priceCents = 0;

    if (store === "ios") {
      const [m] = await appleLookup([storeId], country);
      if (!m) return { error: `No iOS app with id ${storeId}.` };
      meta = m;
      priceCents = m.price_cents ?? 0;
      iaps = await appleInAppPurchases(storeId, country);
    } else {
      meta = await playAppDetail(storeId, country);
      if (!meta) return { error: `No Play app "${storeId}".` };
      priceCents = meta.price_cents ?? 0;
      realInstalls = meta.real_installs ?? null;
    }

    const lifetimeMonths = meta.released_at
      ? Math.max(1, Math.round((Date.now() - new Date(meta.released_at).getTime()) / (30 * 24 * 3600 * 1000)))
      : null;

    // `as any`: scores.mjs is plain JS, so TS infers its `= null` defaults as the literal
    // type null rather than `number | null`. The function itself accepts both.
    const est = revenueEstimate({
      platform: store,
      realInstalls,
      ratingCount: meta.rating_count ?? null,
      priceCents,
      iaps,
      lifetimeMonths,
    } as any);

    // Cache it exactly as the crawler would, so the lookup is paid for once.
    const appId = await upsertApp(dbShim, { ...meta, platform: store, store_id: storeId });
    await q(
      `insert into revenue_estimates (app_id, estimated_on, model, confidence, monthly_usd_low, monthly_usd_high, display, factors)
       values ($1, current_date, $2,$3,$4,$5,$6,$7)
       on conflict (app_id, estimated_on) do update set
         model = excluded.model, confidence = excluded.confidence,
         monthly_usd_low = excluded.monthly_usd_low, monthly_usd_high = excluded.monthly_usd_high,
         display = excluded.display, factors = excluded.factors, computed_at = now()`,
      [appId, est.model, est.confidence, est.monthly_usd_low, est.monthly_usd_high, est.display, JSON.stringify(est.factors)],
    );
    for (const iap of iaps) {
      await q(
        `insert into app_iaps (app_id, name, price_cents, currency, is_subscription, period, annualised_cents, captured_on)
         values ($1,$2,$3,$4,$5,$6,$7, current_date)
         on conflict (app_id, name, captured_on) do update set price_cents = excluded.price_cents`,
        [appId, iap.name, iap.price_cents, iap.currency, iap.is_subscription, iap.period, iap.annualised_cents],
      );
    }

    revalidatePath("/revenue");
    return {
      result: {
        name: meta.name,
        store,
        store_id: storeId,
        model: est.model,
        confidence: est.confidence,
        display: est.display,
        monthly_usd_low: est.monthly_usd_low,
        monthly_usd_high: est.monthly_usd_high,
        factors: est.factors,
        iaps: iaps.map((i) => ({ name: i.name, price_cents: i.price_cents, period: i.period, annualised_cents: i.annualised_cents })),
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Used by the page to show what an estimate was actually built from. */
export async function iapsFor(storeId: string, platform: string) {
  return q(
    `select i.name, i.price_cents, i.currency, i.period, i.annualised_cents
       from app_iaps i join apps a on a.id = i.app_id
      where a.store_id = $1 and a.platform = $2
      order by i.captured_on desc, i.annualised_cents desc nulls last limit 12`,
    [storeId, platform],
  );
}

export async function hasAnyEstimate(): Promise<boolean> {
  const r = await q1<{ n: string }>(`select count(*)::text as n from revenue_estimates`);
  return Number(r?.n ?? 0) > 0;
}
