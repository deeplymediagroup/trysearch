/**
 * /tools/keyword-difficulty — public, no account. One keyword + store + country →
 * live difficulty with the component breakdown and the top-10 SERP with icons.
 * Same pattern as /your-app: server component, GET form, IP rate limit.
 */
import Link from "next/link";
import { q, q1 } from "@/lib/db";
import { fetchIosSerp, fetchAndroidSerp, ensureFetchSink, normalizeTerm } from "@/lib/serp.mjs";
import { suggestDepth } from "@/lib/stores/apple.mjs";
import { playSuggest } from "@/lib/stores/play.mjs";
import { difficulty, difficultyLabel, popularityProxy, popularityProxyAndroid } from "@/lib/scoring/scores.mjs";
import { ScoreCell } from "@/components/ui";
import { headers } from "next/headers";

export const metadata = { title: "Free keyword difficulty checker — trysearch" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAILY_LIMIT = 10;

async function checkRateLimit(): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `ratelimit:keyword-difficulty:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const row = await q1<{ payload: { n: number } }>(
    `insert into upstream_cache (cache_key, payload, expires_at)
     values ($1, '{"n":1}', now() + interval '1 day')
     on conflict (cache_key) do update set payload = jsonb_set(upstream_cache.payload, '{n}', ((upstream_cache.payload->>'n')::int + 1)::text::jsonb)
     returning payload`,
    [key],
  );
  return (row?.payload?.n ?? 1) <= DAILY_LIMIT;
}

async function measure(term: string, platform: "ios" | "android", country: string) {
  ensureFetchSink(async (sql: string, params: any[] = []) => q(sql, params));
  const kw = { term, country, platform };

  // ponytail: SERP is fetched but not persisted — this is a public snapshot, not the crawl.
  const serp = platform === "ios" ? await fetchIosSerp(kw) : await fetchAndroidSerp(kw);
  const diff = difficulty({ top: serp.top.slice(0, 10), term, serpDepth: serp.depth, platform });

  let popularity: number | null = null;
  try {
    const depth = await suggestDepth(term, country, platform, platform === "android" ? { playSuggest } : {});
    popularity = platform === "android"
      ? popularityProxyAndroid(depth, serp.top.map((t: any) => Number(t.real_installs)).filter(Boolean)).value
      : popularityProxy(depth).value;
  } catch {
    /* leave null — missing ≠ zero */
  }

  return { serp, diff, popularity };
}

export default async function KeywordDifficultyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; store?: string; country?: string }>;
}) {
  const { q: raw = "", store = "ios", country = "us" } = await searchParams;
  const platform = store === "android" ? "android" : "ios";
  const term = normalizeTerm(raw);

  let result: Awaited<ReturnType<typeof measure>> | null = null;
  let limited = false;
  let error: string | null = null;

  if (term) {
    if (await checkRateLimit()) {
      try {
        result = await measure(term, platform, country);
      } catch (err: any) {
        error = err.message;
      }
    } else {
      limited = true;
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <p className="mb-1 text-[12px] text-[var(--fg-subtle)]">
        <Link href="/" className="hover:text-[var(--fg)]">trysearch</Link> · free tool
      </p>
      <h1 className="text-[22px] font-semibold">Keyword difficulty</h1>
      <p className="mb-6 mt-1 text-[13px] text-[var(--fg-muted)]">
        Live difficulty from the real store search results — who ranks, how big they are, whether you can beat them.
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
          defaultValue={raw}
          placeholder="Keyword, e.g. habit tracker…"
          className="h-8 min-w-52 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 text-[13px]"
        />
        <button type="submit" className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white">
          Check
        </button>
      </form>

      {limited && <p className="text-[13px] text-[var(--down)]">Daily limit reached for your network — try again tomorrow.</p>}
      {error && <p className="text-[13px] text-[var(--down)]">Store lookup failed: {error}</p>}
      {term && !limited && !error && result && result.serp.depth === 0 && (
        <p className="text-[13px] text-[var(--fg-muted)]">The store returned no results for “{term}” in {country.toUpperCase()}.</p>
      )}

      {result && result.serp.depth > 0 && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <p className="th mb-1">Difficulty</p>
              <div className="flex items-center gap-2">
                <ScoreCell value={result.diff.value} parts={result.diff.parts as Record<string, unknown> | null} label="Difficulty breakdown" />
                <span className="text-[13px] text-[var(--fg-muted)]">{difficultyLabel(result.diff.value)}</span>
              </div>
            </div>
            <div>
              <p className="th mb-1">Popularity</p>
              <p className="num text-[15px]">{result.popularity == null ? "—" : `(${result.popularity})`}</p>
            </div>
            <div>
              <p className="th mb-1">Results returned</p>
              <p className="num text-[15px]">{result.serp.depth}</p>
            </div>
          </div>

          <section>
            <h2 className="th mb-2">Top 10 right now — {term} · {country.toUpperCase()}</h2>
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-chip)] border border-[var(--border)]">
              {result.serp.top.slice(0, 10).map((r: any) => (
                <li key={r.position} className="flex items-center gap-3 p-2.5 text-[12.5px]">
                  <span className="num w-6 shrink-0 text-[var(--fg-subtle)]">#{r.position}</span>
                  <span className="inline-block h-7 w-7 shrink-0 overflow-hidden rounded-[7px] border border-[var(--border)] bg-[var(--bg-hover)]">
                    {r.meta?.icon_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.meta.icon_url} alt="" width={28} height={28} className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.name ?? `(app ${r.store_id})`}</span>
                    {r.subtitle && <span className="block truncate text-[11px] text-[var(--fg-subtle)]">{r.subtitle}</span>}
                  </span>
                  <span className="num shrink-0 text-[11px] text-[var(--fg-muted)]">
                    ★ {r.rating_average ?? "—"} · {r.rating_count == null ? "—" : Number(r.rating_count).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-[11px] text-[var(--fg-subtle)]">
            ( ) = our estimate, not a store-reported number. — = not measured (different from zero).
            Hover the ⓘ for the difficulty inputs. Formulas: <Link className="text-[var(--accent)]" href="/aso-keyword-scores-explained">published in full</Link>.
          </p>
        </div>
      )}
    </main>
  );
}
