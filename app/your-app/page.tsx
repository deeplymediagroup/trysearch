/**
 * /your-app — 01-PRODUCT-SPEC.md §16. The free, no-account snapshot: find any public app,
 * score its listing against live store data, extract the keywords its listing targets, and
 * estimate demand for the top ones.
 *
 * Public and rate-limited per IP per day (counter kept in upstream_cache, so serverless
 * instances share it). ponytail: 10/day is generous for a human, hostile to a scraper.
 */
import Link from "next/link";
import { q, q1 } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { appleSearch, suggestDepth } from "@/lib/stores/apple.mjs";
import { playSearchRanked, playAppDetail, playSuggest, extractListingKeywords } from "@/lib/stores/play.mjs";
import { asoScore, popularityProxy } from "@/lib/scoring/scores.mjs";
import { headers } from "next/headers";

export const metadata = { title: "Free ASO snapshot — trysearch" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAILY_LIMIT = 10;

async function checkRateLimit(): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `ratelimit:your-app:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const row = await q1<{ payload: { n: number } }>(
    `insert into upstream_cache (cache_key, payload, expires_at)
     values ($1, '{"n":1}', now() + interval '1 day')
     on conflict (cache_key) do update set payload = jsonb_set(upstream_cache.payload, '{n}', ((upstream_cache.payload->>'n')::int + 1)::text::jsonb)
     returning payload`,
    [key],
  );
  return (row?.payload?.n ?? 1) <= DAILY_LIMIT;
}

async function snapshot(query: string, platform: "ios" | "android", country: string) {
  setFetchSink({ query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) });

  // 1. Find the app — a name, or a bare id/package.
  let app: any = null;
  if (platform === "ios") {
    const idMatch = query.match(/(?:^|id)(\d{6,})/);
    const results = idMatch ? await appleSearch(query.replace(/\D/g, " "), country, 5).catch(() => []) : [];
    app = results.find((a: any) => a.store_id === idMatch?.[1]) ?? (await appleSearch(query, country, 5))[0] ?? null;
  } else {
    const pkg = query.match(/([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,})/i)?.[1];
    if (pkg) app = await playAppDetail(pkg, country);
    if (!app) {
      const [first] = await playSearchRanked(query, country);
      if (first) app = await playAppDetail(first.store_id, country);
    }
  }
  if (!app) return null;

  // 2. Score the listing.
  const score = asoScore({
    name: app.name ?? "",
    description: app.description ?? "",
    screenshot_urls: app.screenshot_urls ?? [],
    rating_average: app.rating_average,
    rating_count: app.rating_count,
    version_released_at: app.version_released_at,
    release_notes: app.release_notes ?? "",
  });

  // 3. Keywords the listing targets, top 5 enriched with a live demand estimate.
  const extracted = extractListingKeywords(app, { max: 12 });
  const enriched: any[] = [];
  for (const k of extracted.slice(0, 5)) {
    try {
      const depth = await suggestDepth(k.term, country, platform, platform === "android" ? { playSuggest } : {});
      enriched.push({ ...k, popularity_estimate: popularityProxy(depth).value });
    } catch {
      enriched.push({ ...k, popularity_estimate: null });
    }
  }

  return { app, score, extracted, enriched };
}

export default async function YourAppPage({ searchParams }: { searchParams: Promise<{ q?: string; store?: string; country?: string }> }) {
  const { q: query = "", store = "ios", country = "us" } = await searchParams;
  const platform = store === "android" ? "android" : "ios";

  let result: Awaited<ReturnType<typeof snapshot>> | null = null;
  let limited = false;
  let error: string | null = null;

  if (query.trim()) {
    if (await checkRateLimit()) {
      try {
        result = await snapshot(query.trim(), platform, country);
      } catch (err: any) {
        error = err.message;
      }
    } else {
      limited = true;
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <p className="mb-1 text-[12px] text-[var(--fg-subtle)]"><Link href="/" className="hover:text-[var(--fg)]">trysearch</Link> · free tool</p>
      <h1 className="text-[22px] font-semibold">See it with your app</h1>
      <p className="mb-6 mt-1 text-[13px] text-[var(--fg-muted)]">
        Free snapshot — no account needed. Find your app and we&apos;ll score its listing against live store data.
      </p>

      <form method="get" className="mb-8 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {(["ios", "android"] as const).map((p) => (
            <label key={p} className={`cursor-pointer rounded-[5px] px-2 py-1 text-[12px] ${platform === p ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}>
              <input type="radio" name="store" value={p} defaultChecked={platform === p} className="sr-only" />
              {p === "ios" ? "iOS" : "Android"}
            </label>
          ))}
        </span>
        <select name="country" defaultValue={country} className="h-8 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] px-2 text-[12px]">
          {["us", "gb", "ca", "au", "de", "fr", "jp"].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
        </select>
        <input
          name="q"
          defaultValue={query}
          placeholder="App name, store URL, or app ID…"
          className="h-8 min-w-52 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 text-[13px]"
        />
        <button type="submit" className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white">
          Find my app
        </button>
      </form>

      {limited && <p className="text-[13px] text-[var(--down)]">Daily snapshot limit reached for your network — try again tomorrow.</p>}
      {error && <p className="text-[13px] text-[var(--down)]">Store lookup failed: {error}</p>}
      {query && !limited && !error && !result && <p className="text-[13px] text-[var(--fg-muted)]">No app found for “{query}”. Try the exact store name or an ID.</p>}

      {result && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            {result.app.icon_url && <img src={result.app.icon_url} alt="" width={44} height={44} className="rounded-[10px]" />}
            <div>
              <p className="text-[15px] font-semibold">{result.app.name}</p>
              <p className="text-[12px] text-[var(--fg-muted)]">
                {result.app.developer_name} · ★ {result.app.rating_average ?? "—"} ({(result.app.rating_count ?? 0).toLocaleString()})
              </p>
            </div>
            <p className="num ml-auto text-[26px] font-semibold">
              {result.score.score}<span className="text-[14px] text-[var(--fg-subtle)]">/100</span>
            </p>
          </div>

          <section>
            <h2 className="th mb-2">Listing audit — nine checks, each with the fix</h2>
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-chip)] border border-[var(--border)]">
              {result.score.checks.map((c: any) => (
                <li key={c.name} className="flex items-start gap-3 p-2.5 text-[12.5px]">
                  <span className={`num w-12 shrink-0 ${c.status === "good" ? "text-[var(--up)]" : c.status === "fair" ? "text-[var(--warn)]" : "text-[var(--down)]"}`}>
                    {c.score}/{c.maxScore}
                  </span>
                  <span className="w-36 shrink-0 font-medium">{c.name}</span>
                  <span className="text-[var(--fg-muted)]">{c.tip}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="th mb-2">Keywords your listing targets</h2>
            <ul className="space-y-1.5">
              {result.enriched.map((k: any) => (
                <li key={k.term} className="flex items-center gap-3 text-[12.5px]">
                  <span className="num min-w-40">{k.term}</span>
                  <span className="text-[11px] text-[var(--fg-subtle)]">listing score {Math.round(k.score * 100) / 100}</span>
                  <span className="num ml-auto">{k.popularity_estimate == null ? "—" : `(${k.popularity_estimate})`}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
              ( ) = our live demand estimate from autocomplete depth, 0–100. Full popularity, difficulty and daily rank
              tracking live in the console.
            </p>
            {result.extracted.length > 5 && (
              <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">+ {result.extracted.length - 5} more extracted: {result.extracted.slice(5).map((k: any) => k.term).join(", ")}</p>
            )}
          </section>

          <p className="text-[12px] text-[var(--fg-muted)]">
            How the scores work: <Link className="text-[var(--accent)]" href="/aso-keyword-scores-explained">every formula, published</Link>.
          </p>
        </div>
      )}
    </main>
  );
}
