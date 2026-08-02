"use server";

/**
 * The three AI features — 01-PRODUCT-SPEC.md §4.3 (AI analyses), §5 (Analyze reviews),
 * §9 (Generate listing). Every result is stored so past reports stay readable, and the
 * expensive one (competitive landscape) carries the spec's 7-day cooldown.
 */
import { revalidatePath } from "next/cache";
import { q, q1, currentWorkspace } from "@/lib/db";
import { aiEnabled, aiJson, AI_MODEL } from "@/lib/ai";

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

const THEME_LIST = {
  type: "array",
  items: {
    type: "object",
    properties: {
      theme: { type: "string" },
      count: { type: "integer" },
      quotes: { type: "array", items: { type: "string" } },
    },
    required: ["theme", "count", "quotes"],
    additionalProperties: false,
  },
} as const;

/** §5 — Analyze reviews: praise / complaints / feature requests with representative quotes. */
export async function analyzeReviews(appId: string) {
  if (!aiEnabled()) return { error: "ANTHROPIC_API_KEY is not set." };
  const ws = await workspaceId();

  const owned = await q1(
    `select 1 from tracked_apps where app_id = $1 and workspace_id = $2 and is_active`,
    [appId, ws],
  );
  if (!owned) return { error: "App is not tracked by this workspace." };

  const reviews = await q<{ rating: number; title: string | null; body: string | null; reviewed_at: string; app_version: string | null }>(
    `select rating, title, body, reviewed_at, app_version from reviews
      where app_id = $1 order by reviewed_at desc limit 150`,
    [appId],
  );
  if (reviews.length < 5) return { error: "Not enough reviews to analyze — run the reviews crawl first." };

  const corpus = reviews
    .map((r) => `[${r.rating}★${r.app_version ? ` v${r.app_version}` : ""}] ${r.title ?? ""} — ${r.body ?? ""}`)
    .join("\n");

  try {
    const result = await aiJson<{ praise: any[]; complaints: any[]; feature_requests: any[] }>({
      system:
        "You are an App Store review analyst. Group reviews into recurring themes. Quotes must be verbatim substrings of the provided reviews, at most 2 per theme, each under 140 characters. Counts are how many reviews touch the theme. Order themes by count descending, max 6 per group.",
      prompt: `Analyze these ${reviews.length} app store reviews:\n\n${corpus}`,
      schema: {
        type: "object",
        properties: { praise: THEME_LIST, complaints: THEME_LIST, feature_requests: THEME_LIST },
        required: ["praise", "complaints", "feature_requests"],
        additionalProperties: false,
      },
    });

    const oldest = reviews[reviews.length - 1].reviewed_at;
    const newest = reviews[0].reviewed_at;
    await q(
      `insert into review_analyses (app_id, window_start, window_end, review_count, praise, complaints, feature_requests, model)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [appId, oldest, newest, reviews.length, JSON.stringify(result.praise), JSON.stringify(result.complaints), JSON.stringify(result.feature_requests), AI_MODEL],
    );
    revalidatePath("/reviews");
    return { ok: true };
  } catch (err: any) {
    return { error: err.message };
  }
}

/** §4.3 — AI competitive landscape, at most one per app per 7 days. */
export async function generateLandscape(trackedAppId: string) {
  if (!aiEnabled()) return { error: "ANTHROPIC_API_KEY is not set." };
  const ws = await workspaceId();

  // Ratings and subtitle live on app_snapshots, not apps — join the latest snapshot.
  const app = await q1<{ app_id: string; name: string; subtitle: string | null; rating_average: number | null; rating_count: number | null }>(
    `select ta.app_id, a.name, s.subtitle, s.rating_average, s.rating_count
       from tracked_apps ta
       join apps a on a.id = ta.app_id
       left join lateral (
         select subtitle, rating_average, rating_count from app_snapshots
          where app_id = a.id order by captured_on desc limit 1
       ) s on true
      where ta.id = $1 and ta.workspace_id = $2 and ta.is_active`,
    [trackedAppId, ws],
  );
  if (!app) return { error: "App is not tracked by this workspace." };

  const last = await q1<{ created_at: string }>(
    `select created_at from ai_analyses where tracked_app_id = $1 order by created_at desc limit 1`,
    [trackedAppId],
  );
  if (last) {
    const ageMs = Date.now() - new Date(last.created_at).getTime();
    const coolMs = 7 * 24 * 3600 * 1000;
    if (ageMs < coolMs) {
      const daysLeft = Math.ceil((coolMs - ageMs) / (24 * 3600 * 1000));
      return { error: `Cooldown: one analysis per app per 7 days. ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining.` };
    }
  }

  const competitors = await q(
    `select a.name, a.version, s.subtitle, s.rating_average, s.rating_count
       from tracked_apps ta
       join apps a on a.id = ta.app_id
       left join lateral (
         select subtitle, rating_average, rating_count from app_snapshots
          where app_id = a.id order by captured_on desc limit 1
       ) s on true
      where ta.workspace_id = $1 and ta.role = 'competitor' and ta.is_active limit 10`,
    [ws],
  );
  if (!competitors.length) return { error: "No competitors tracked — add one first." };

  const positions = await q(
    `select k.term, k.country, cp.bucket, cp.their_rank, cp.our_rank, cp.opportunity,
            k.popularity, k.popularity_estimate, k.difficulty, ca.name as competitor_name
       from competitive_positions cp
       join keywords k on k.id = cp.keyword_id
       left join apps ca on ca.id = cp.best_competitor_app_id
      where cp.tracked_app_id = $1
      order by cp.opportunity desc nulls last limit 60`,
    [trackedAppId],
  );

  const ITEM = {
    type: "array",
    items: {
      type: "object",
      properties: { title: { type: "string" }, detail: { type: "string" } },
      required: ["title", "detail"],
      additionalProperties: false,
    },
  };

  try {
    const result = await aiJson<{ posture: string; opportunities: any[]; threats: any[]; strengths: any[] }>({
      system:
        "You are an ASO competitive strategist. Ground every claim in the data provided — cite keywords and ranks. Posture is a 2-3 sentence overall read. 3-5 items per list, each detail 1-2 sentences and actionable.",
      prompt:
        `MY APP: ${JSON.stringify(app)}\n\nCOMPETITORS: ${JSON.stringify(competitors)}\n\n` +
        `COMPETITIVE POSITIONS (bucket: gap = they rank / we don't, winnable = low-difficulty gap, threat = they outrank us, lead = we outrank all):\n${JSON.stringify(positions)}`,
      schema: {
        type: "object",
        properties: { posture: { type: "string" }, opportunities: ITEM, threats: ITEM, strengths: ITEM },
        required: ["posture", "opportunities", "threats", "strengths"],
        additionalProperties: false,
      },
    });

    await q(
      `insert into ai_analyses (tracked_app_id, kind, posture, opportunities, threats, strengths, model)
       values ($1,'competitive_landscape',$2,$3,$4,$5,$6)`,
      [trackedAppId, result.posture, JSON.stringify(result.opportunities), JSON.stringify(result.threats), JSON.stringify(result.strengths), AI_MODEL],
    );
    revalidatePath("/competitors");
    return { ok: true };
  } catch (err: any) {
    return { error: err.message };
  }
}

/** §9 — Generate a store-ready listing draft. The keyword field itself stays pure code (the packer). */
export async function generateListing(trackedAppId: string, locale: string, details: string) {
  if (!aiEnabled()) return { error: "ANTHROPIC_API_KEY is not set." };
  const ws = await workspaceId();

  const app = await q1<{ app_id: string; name: string; platform: string }>(
    `select ta.app_id, a.name, a.platform from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.id = $1 and ta.workspace_id = $2 and ta.is_active`,
    [trackedAppId, ws],
  );
  if (!app) return { error: "App is not tracked by this workspace." };

  const keywords = await q<{ term: string; popularity: number | null; popularity_estimate: number | null; difficulty: number | null; is_branded: boolean }>(
    `select k.term, k.popularity, k.popularity_estimate, k.difficulty, tk.is_branded
       from tracked_keywords tk join keywords k on k.id = tk.keyword_id
      where tk.tracked_app_id = $1 order by coalesce(k.popularity, k.popularity_estimate, 0) desc limit 30`,
    [trackedAppId],
  );

  const snapshot = await q1<{ name: string; subtitle: string | null; description: string | null }>(
    `select s.name, s.subtitle, s.description from app_snapshots s
      where s.app_id = $1 order by s.captured_on desc limit 1`,
    [app.app_id],
  );

  try {
    const draft = await aiJson<{ app_name: string; subtitle: string; promotional_text: string; description: string }>({
      system:
        "You write App Store listings. HARD LIMITS (count every character including spaces): app_name ≤ 30, subtitle ≤ 30, promotional_text ≤ 170, description ≤ 4000. " +
        "The highest-demand non-branded keyword goes in app_name, the next ones in subtitle. Never repeat a word across app_name and subtitle — Apple indexes them as one bag of words. " +
        "Never use competitor brand names or people's names in indexed fields. Description is benefit-led prose, not keyword soup (it is not indexed by Apple search).",
      prompt:
        `App: ${app.name} (${app.platform})\nLocale: ${locale}\n\nCurrent listing: ${JSON.stringify(snapshot)}\n\n` +
        `Tracked keywords (demand-sorted; branded flagged): ${JSON.stringify(keywords)}\n\nExtra details from the developer: ${details || "none"}`,
      schema: {
        type: "object",
        properties: {
          app_name: { type: "string" },
          subtitle: { type: "string" },
          promotional_text: { type: "string" },
          description: { type: "string" },
        },
        required: ["app_name", "subtitle", "promotional_text", "description"],
        additionalProperties: false,
      },
    });

    // The keyword field comes from the pure-code packer, seeded with what the draft consumed.
    const { packKeywordField, isMetadataSafe, appNameBlocklist } = await import("@/lib/scoring/listing.mjs");
    const knownApps = await q(`select name, developer_name, store_id from apps where platform = $1 limit 3000`, [app.platform]);
    const blocklist = appNameBlocklist(knownApps as any[], null);
    const candidates = keywords
      .map((k) => ({ term: k.term, score: k.popularity ?? k.popularity_estimate ?? 0, metadataSafe: isMetadataSafe(k.term, { blocklist }).safe }))
      .sort((a, b) => b.score - a.score);
    const packed = packKeywordField(candidates, {
      app_name: draft.app_name,
      subtitle: draft.subtitle,
      keywords_field: null,
      description: draft.description,
    });

    await q(
      `insert into listing_drafts (tracked_app_id, locale, app_name, subtitle, keywords_field, promotional_text, description, rationale, model)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trackedAppId, locale, draft.app_name, draft.subtitle, packed.field, draft.promotional_text, draft.description, JSON.stringify(packed.because ?? {}), AI_MODEL],
    );
    revalidatePath("/listing-helper");
    return { ok: true };
  } catch (err: any) {
    return { error: err.message };
  }
}
