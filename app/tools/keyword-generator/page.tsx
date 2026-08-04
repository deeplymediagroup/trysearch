/**
 * /tools/keyword-generator — public, no account. Seed keyword (or app name/description)
 * → autocomplete expansion + optional AI intent phrases, every AI candidate verified
 * against live autocomplete before it earns a row. Same shape as /your-app: server
 * component, GET form, IP rate limit in upstream_cache.
 */
import Link from "next/link";
import { q, q1 } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { appleAutocomplete, suggestDepth } from "@/lib/stores/apple.mjs";
import { playSuggest } from "@/lib/stores/play.mjs";
import { popularityProxy } from "@/lib/scoring/scores.mjs";
import { aiEnabled, generateKeywordCandidates, verifyCandidate } from "@/lib/ai.mjs";
import { normalizeTerm } from "@/lib/serp.mjs";
import { headers } from "next/headers";

export const metadata = { title: "Free keyword generator — trysearch" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAILY_LIMIT = 10;

async function checkRateLimit(): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `ratelimit:keyword-generator:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const row = await q1<{ payload: { n: number } }>(
    `insert into upstream_cache (cache_key, payload, expires_at)
     values ($1, '{"n":1}', now() + interval '1 day')
     on conflict (cache_key) do update set payload = jsonb_set(upstream_cache.payload, '{n}', ((upstream_cache.payload->>'n')::int + 1)::text::jsonb)
     returning payload`,
    [key],
  );
  return (row?.payload?.n ?? 1) <= DAILY_LIMIT;
}

type Row = { term: string; source: "autocomplete" | "expansion" | "ai"; popularity_estimate: number | null };

async function generate(seed: string, platform: "ios" | "android", country: string) {
  setFetchSink({ query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) });
  const suggest = (prefix: string) =>
    platform === "ios" ? appleAutocomplete(prefix, country) : playSuggest(prefix, country);

  const seen = new Set<string>();
  const rows: Row[] = [];
  const add = (term: string, source: Row["source"]) => {
    const n = normalizeTerm(term);
    if (!n || n === normalizeTerm(seed) || seen.has(n)) return;
    seen.add(n);
    rows.push({ term: n, source, popularity_estimate: null });
  };

  // 1. Base autocomplete on the seed.
  const base: string[] = await suggest(seed).catch(() => []);
  for (const t of base) add(t, "autocomplete");

  // 2. Expansion round: autocomplete the first few results themselves.
  // ponytail: 3 expansions keeps it well under the 60s cap; a full a-z fan-out belongs in the crawler.
  for (const t of base.slice(0, 3)) {
    const more: string[] = await suggest(t).catch(() => []);
    for (const m of more) add(m, "expansion");
  }

  // 3. Optional AI intent phrases — every candidate must survive live autocomplete.
  let aiUsed = false;
  if (aiEnabled()) {
    aiUsed = true;
    try {
      const candidates = await generateKeywordCandidates({
        app: { name: seed, description: seed },
        existing: [...seen] as never[], // generateKeywordCandidates is untyped .mjs; its default [] infers never[]
        max: 15,
      });
      for (const c of candidates.slice(0, 10)) {
        try {
          const suggestions = await suggest(c);
          if (verifyCandidate(c, suggestions)) add(c, "ai");
        } catch {
          /* one bad candidate must not abandon the rest */
        }
      }
    } catch {
      aiUsed = false; // AI failed — the autocomplete rows still stand.
    }
  }

  // 4. On-the-spot popularity where cheap: depth walk for the first handful only.
  const out = rows.slice(0, 30);
  for (const row of out.slice(0, 6)) {
    try {
      const depth = await suggestDepth(row.term, country, platform, platform === "android" ? { playSuggest } : {});
      row.popularity_estimate = popularityProxy(depth).value;
    } catch {
      /* leave null — missing ≠ zero */
    }
  }

  return { rows: out, aiUsed };
}

export default async function KeywordGeneratorPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; store?: string; country?: string }>;
}) {
  const { q: query = "", store = "ios", country = "us" } = await searchParams;
  const platform = store === "android" ? "android" : "ios";

  let result: Awaited<ReturnType<typeof generate>> | null = null;
  let limited = false;
  let error: string | null = null;

  if (query.trim()) {
    if (await checkRateLimit()) {
      try {
        result = await generate(query.trim(), platform, country);
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
      <h1 className="text-[22px] font-semibold">Keyword generator</h1>
      <p className="mb-6 mt-1 text-[13px] text-[var(--fg-muted)]">
        Seed keyword or app idea in, real search phrases out — expanded through live store autocomplete.
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
          placeholder="Seed keyword or what your app does…"
          className="h-8 min-w-52 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 text-[13px]"
        />
        <button type="submit" className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white">
          Generate
        </button>
      </form>

      {limited && <p className="text-[13px] text-[var(--down)]">Daily limit reached for your network — try again tomorrow.</p>}
      {error && <p className="text-[13px] text-[var(--down)]">Store lookup failed: {error}</p>}
      {query && !limited && !error && result && result.rows.length === 0 && (
        <p className="text-[13px] text-[var(--fg-muted)]">Autocomplete surfaced nothing for “{query}”. Try a shorter, more generic seed.</p>
      )}

      {result && result.rows.length > 0 && (
        <section>
          <h2 className="th mb-2">{result.rows.length} terms real users type</h2>
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-chip)] border border-[var(--border)]">
            {result.rows.map((k) => (
              <li key={k.term} className="flex items-center gap-3 p-2.5 text-[12.5px]">
                <span className="num min-w-0 flex-1 truncate">{k.term}</span>
                <span className="text-[11px] text-[var(--fg-subtle)]">
                  {k.source === "ai" ? "AI · verified live" : k.source}
                </span>
                <span className="num w-12 text-right">{k.popularity_estimate == null ? "—" : `(${k.popularity_estimate})`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
            ( ) = live demand estimate from autocomplete depth, 0–100, computed for the first few terms.
            — = not measured (different from zero).{result.aiUsed ? " AI candidates only appear if live autocomplete confirms real people type them." : ""}
          </p>
          <p className="mt-2 text-[12px] text-[var(--fg-muted)]">
            Want popularity, difficulty and daily rank tracking for all of them? That&apos;s the console.
          </p>
        </section>
      )}
    </main>
  );
}
