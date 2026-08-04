/**
 * /roast — the App Store Roast. Public, no account. Paste an app link, id or name →
 * we fetch the live listing and grade it F to A+ with brutal-but-useful one-liners.
 * AI (lib/ai.mjs) writes the roast when ANTHROPIC_API_KEY is set; otherwise a
 * deterministic heuristic grades it — the page is never dead.
 */
import Link from "next/link";
import { q, q1 } from "@/lib/db";
import { setFetchSink } from "@/lib/stores/http.mjs";
import { parseAppRef } from "@/lib/stores/resolve.mjs";
import { appleLookup, appleSearch } from "@/lib/stores/apple.mjs";
import { playAppDetail, playSearchRanked } from "@/lib/stores/play.mjs";
import { asoScore } from "@/lib/scoring/scores.mjs";
import { aiEnabled, aiJson } from "@/lib/ai.mjs";
import { headers } from "next/headers";

export const metadata = { title: "App Store Roast — trysearch" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAILY_LIMIT = 10;
const GRADES = ["A+", "A", "B", "C", "D", "F"] as const;
type Grade = (typeof GRADES)[number];

async function checkRateLimit(): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `ratelimit:roast:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const row = await q1<{ payload: { n: number } }>(
    `insert into upstream_cache (cache_key, payload, expires_at)
     values ($1, '{"n":1}', now() + interval '1 day')
     on conflict (cache_key) do update set payload = jsonb_set(upstream_cache.payload, '{n}', ((upstream_cache.payload->>'n')::int + 1)::text::jsonb)
     returning payload`,
    [key],
  );
  return (row?.payload?.n ?? 1) <= DAILY_LIMIT;
}

/** Paste anything → the full live listing, via the shared parser in lib/stores/resolve.mjs. */
async function resolveListing(input: string, store: "ios" | "android", country: string): Promise<any | null> {
  setFetchSink({ query: async (sql: string, params: any[] = []) => ({ rows: await q(sql, params) }) });
  const ref = parseAppRef(input);
  if (!ref) return null;
  const cc = ref.country ?? country;

  if (ref.store === "ios" && ref.id) return (await appleLookup([ref.id], cc))[0] ?? null;
  if (ref.store === "android" && ref.id) return playAppDetail(ref.id, cc);
  if (ref.bundle) {
    // A dotted token is valid on both stores — ask both, prefer the picker's store.
    const [ios, android] = await Promise.all([
      appleLookup([ref.bundle], cc, { bundleId: true }).catch(() => [] as any[]),
      playAppDetail(ref.bundle, cc).catch(() => null),
    ]);
    return store === "android" ? (android ?? ios[0] ?? null) : (ios[0] ?? android ?? null);
  }
  // Name search on the selected store.
  if (store === "ios") return (await appleSearch(ref.query!, cc, 1))[0] ?? null;
  const [first] = await playSearchRanked(ref.query!, cc);
  return first ? playAppDetail(first.store_id, cc) : null;
}

type Roast = {
  grade: Grade;
  lines: string[];
  fields: { field: string; grade: Grade; note: string }[];
  source: "ai" | "heuristic";
};

function gradeFromRatio(r: number): Grade {
  if (r >= 0.95) return "A+";
  if (r >= 0.85) return "A";
  if (r >= 0.7) return "B";
  if (r >= 0.5) return "C";
  if (r >= 0.3) return "D";
  return "F";
}

/** Deterministic fallback: grades derived from the same public numbers the AI would read. */
function heuristicRoast(app: any): Roast {
  const name = String(app.name ?? "");
  const subtitle = String(app.subtitle ?? app.summary ?? "");
  const shots = (app.screenshot_urls ?? []).length;
  const desc = String(app.description ?? "");
  const ratingAvg = app.rating_average == null ? null : Number(app.rating_average);
  const ratingCount = app.rating_count == null ? 0 : Number(app.rating_count);

  const score = asoScore({
    name,
    description: desc,
    screenshot_urls: app.screenshot_urls ?? [],
    rating_average: app.rating_average,
    rating_count: app.rating_count,
    version_released_at: app.version_released_at,
    release_notes: app.release_notes ?? "",
  });

  const fields = [
    {
      field: "Name",
      grade: gradeFromRatio(name.length >= 15 && name.length <= 30 ? 1 : name.length >= 8 ? 0.7 : 0.3),
      note: name.length < 8 ? "Too short to carry a single keyword." : name.length > 30 ? "Longer than the store even shows." : "Length is fine — is every word earning search traffic?",
    },
    {
      field: "Subtitle",
      grade: subtitle ? gradeFromRatio(subtitle.length <= 30 ? 0.9 : 0.6) : "F",
      note: subtitle ? "Present — make sure it isn't repeating the name's keywords." : "Missing. That's 30 characters of free ranking surface, unused.",
    },
    {
      field: "Screenshots",
      grade: gradeFromRatio(Math.min(shots, 8) / 8),
      note: shots >= 8 ? `${shots} screenshots — full deck.` : shots > 0 ? `Only ${shots}. Competitors run 8-10.` : "Zero screenshots found. Nobody installs a mystery.",
    },
    {
      field: "Description",
      grade: gradeFromRatio(Math.min(desc.length, 2000) / 2000),
      note: desc.length < 300 ? `${desc.length} characters. That's a tweet, not a pitch.` : desc.length < 1500 ? "Decent length — front-load the first three lines." : "Full-length. Good.",
    },
    {
      field: "Ratings",
      grade: ratingAvg == null ? "F" : gradeFromRatio((Math.max(0, ratingAvg - 3) / 2) * Math.min(1, Math.log10(ratingCount + 1) / 4)),
      note: ratingAvg == null ? "No rating data at all." : `★ ${ratingAvg} across ${ratingCount.toLocaleString()} ratings.`,
    },
  ] as Roast["fields"];

  const lines = [
    ...score.checks.filter((c: any) => c.status !== "good").slice(0, 5).map((c: any) => `${c.name}: ${c.tip}`),
  ];
  if (lines.length < 4) lines.push("Honestly? Not much to roast. Now go rank for something.");

  return { grade: gradeFromRatio(score.score / 100), lines: lines.slice(0, 6), fields, source: "heuristic" };
}

async function aiRoast(app: any): Promise<Roast> {
  const shots = (app.screenshot_urls ?? []).length;
  const result = await aiJson({
    system:
      "You are a brutally honest ASO reviewer. Grade an app store listing F to A+ overall and per field, with 4-6 short roast one-liners — funny but each must contain a real, actionable fix. Never invent data you weren't given. Grades only from: A+, A, B, C, D, F.",
    prompt:
      `LISTING\nName: ${app.name ?? ""}\nSubtitle: ${app.subtitle ?? app.summary ?? "(none)"}\n` +
      `Screenshots: ${shots}\nRating: ${app.rating_average ?? "unknown"} across ${app.rating_count ?? "unknown"} ratings\n` +
      `Description:\n${String(app.description ?? "").slice(0, 2500)}\n\n` +
      `Grade these five fields exactly: Name, Subtitle, Screenshots, Description, Ratings.`,
    schema: {
      type: "object",
      properties: {
        grade: { type: "string", enum: [...GRADES] },
        lines: { type: "array", items: { type: "string" } },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              grade: { type: "string", enum: [...GRADES] },
              note: { type: "string" },
            },
            required: ["field", "grade", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["grade", "lines", "fields"],
      additionalProperties: false,
    },
  });
  return { grade: result.grade, lines: result.lines.slice(0, 6), fields: result.fields.slice(0, 6), source: "ai" };
}

const GRADE_COLOUR: Record<Grade, string> = {
  "A+": "var(--up)", A: "var(--up)", B: "var(--rank-4-10)", C: "var(--warn)", D: "var(--rank-31-100)", F: "var(--down)",
};

export default async function RoastPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; store?: string; country?: string }>;
}) {
  const { q: query = "", store = "ios", country = "us" } = await searchParams;
  const platform = store === "android" ? "android" : "ios";

  let app: any = null;
  let roast: Roast | null = null;
  let limited = false;
  let error: string | null = null;

  if (query.trim()) {
    if (await checkRateLimit()) {
      try {
        app = await resolveListing(query.trim(), platform, country);
        if (app) {
          if (aiEnabled()) {
            roast = await aiRoast(app).catch(() => heuristicRoast(app)); // never a dead page
          } else {
            roast = heuristicRoast(app);
          }
        }
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
      <h1 className="text-[22px] font-semibold">App Store Roast</h1>
      <p className="mb-6 mt-1 text-[13px] text-[var(--fg-muted)]">
        Paste your app. Get graded. It only hurts because it&apos;s fixable.
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
          placeholder="Store link, app id, or app name…"
          className="h-8 min-w-52 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] px-2.5 text-[13px]"
        />
        <button type="submit" className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white">
          Roast it
        </button>
      </form>

      {limited && <p className="text-[13px] text-[var(--down)]">Daily roast limit reached for your network — try again tomorrow.</p>}
      {error && <p className="text-[13px] text-[var(--down)]">Store lookup failed: {error}</p>}
      {query && !limited && !error && !app && (
        <p className="text-[13px] text-[var(--fg-muted)]">No app found for “{query}”. Paste a store link or the exact name.</p>
      )}

      {app && roast && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            {app.icon_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={app.icon_url} alt="" width={44} height={44} className="rounded-[10px]" />
            )}
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{app.name}</p>
              <p className="text-[12px] text-[var(--fg-muted)]">
                {app.developer_name} · ★ {app.rating_average ?? "—"} ({(app.rating_count ?? 0).toLocaleString()})
              </p>
            </div>
            <p className="num ml-auto text-[40px] font-bold leading-none" style={{ color: GRADE_COLOUR[roast.grade] }}>
              {roast.grade}
            </p>
          </div>

          <section>
            <h2 className="th mb-2">The roast</h2>
            <ul className="space-y-1.5">
              {roast.lines.map((line, i) => (
                <li key={i} className="flex gap-2 text-[13px]">
                  <span aria-hidden className="text-[var(--accent)]">🔥</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="th mb-2">Field by field</h2>
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-chip)] border border-[var(--border)]">
              {roast.fields.map((f) => (
                <li key={f.field} className="flex items-start gap-3 p-2.5 text-[12.5px]">
                  <span className="num w-8 shrink-0 font-semibold" style={{ color: GRADE_COLOUR[f.grade] ?? "var(--fg)" }}>
                    {f.grade}
                  </span>
                  <span className="w-28 shrink-0 font-medium">{f.field}</span>
                  <span className="text-[var(--fg-muted)]">{f.note}</span>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-[11px] text-[var(--fg-subtle)]">
            {roast.source === "ai" ? "Graded by AI from the live listing." : "Graded by our published heuristics from the live listing."}{" "}
            Fix it properly with the <Link className="text-[var(--accent)]" href="/your-app">free ASO snapshot</Link>.
          </p>
        </div>
      )}
    </main>
  );
}
