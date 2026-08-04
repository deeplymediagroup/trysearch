"use server";

/**
 * On-demand discovery — the "Re-run discovery" button (nightly's `discovery` job stays the
 * thorough version; this is the bounded, interactive one).
 *
 * Runs inside `after()` on a Vercel function budget, so every phase is capped: autocomplete
 * expansion over the listing's words, AI candidates verified against live autocomplete, and
 * one relevance batch. Progress is written to discovery_runs so the UI can poll it.
 */
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { q, q1, exec, currentWorkspace } from "@/lib/db";
import { appleAutocomplete } from "@/lib/stores/apple.mjs";
import { playSuggest } from "@/lib/stores/play.mjs";
import { aiEnabled, generateKeywordCandidates, verifyCandidate, scoreRelevance } from "@/lib/ai.mjs";
import { opportunity, popularityEffective } from "@/lib/scoring/scores.mjs";
import { tokens } from "@/lib/scoring/text.mjs";

const MAX_SEEDS = 25;
const MAX_AI = 40;

/** Same normalisation and conflict target as lib/db.mjs upsertKeyword, over the app-side pool. */
async function upsertKeywordRow({ term, platform, country }: { term: string; platform: string; country: string }) {
  const normalized = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 1;
  return q1<{ id: string; popularity: number | null; popularity_estimate: number | null; difficulty: number | null }>(
    `insert into keywords (term, term_normalized, platform, country, language, word_count)
     values ($1,$2,$3,$4,null,$5)
     on conflict (term_normalized, platform, country) do update set term = keywords.term
     returning id, popularity, popularity_estimate, difficulty`,
    [term, normalized, platform, country, wordCount],
  );
}

export async function runDiscovery(trackedAppId: string, countries: string[]): Promise<{ runId?: string; error?: string }> {
  const ws = (await currentWorkspace())?.id;
  if (!ws) return { error: "No workspace." };
  const app = await q1<{ tracked_app_id: string; app_id: string; platform: string; store_id: string; name: string; subtitle: string | null; description: string | null; workspace_id: string }>(
    `select ta.id as tracked_app_id, ta.app_id, ta.workspace_id, a.platform, a.store_id, a.name, a.subtitle, a.description
       from tracked_apps ta join apps a on a.id = ta.app_id
      where ta.id = $1 and ta.workspace_id = $2 and ta.role = 'own'`,
    [trackedAppId, ws],
  );
  if (!app) return { error: "App not found." };
  const cc = [...new Set(countries.map((c) => c.toLowerCase()))].slice(0, 3);
  if (!cc.length) return { error: "Pick at least one market." };

  const running = await q1<{ id: string }>(
    `select id from discovery_runs where tracked_app_id = $1 and status = 'running' and started_at > now() - interval '10 minutes'`,
    [trackedAppId],
  );
  if (running) return { error: "A discovery run is already in progress." };

  const run = await q1<{ id: string }>(
    `insert into discovery_runs (tracked_app_id, countries, progress) values ($1, $2, 'Queued…') returning id`,
    [trackedAppId, cc],
  );
  if (!run) return { error: "Could not start the run." };

  after(() => executeRun(run.id, app, cc).catch(async (err) => {
    await exec(`update discovery_runs set status = 'error', progress = $2, finished_at = now() where id = $1`, [run.id, String(err?.message ?? err).slice(0, 300)]);
  }));

  revalidatePath("/keywords");
  return { runId: run.id };
}

async function executeRun(
  runId: string,
  app: { tracked_app_id: string; app_id: string; platform: string; store_id: string; name: string; subtitle: string | null; description: string | null; workspace_id: string },
  countries: string[],
) {
  const setProgress = (p: string) => exec(`update discovery_runs set progress = $2 where id = $1`, [runId, p]);
  const suggest = (prefix: string, country: string) =>
    app.platform === "ios" ? appleAutocomplete(prefix, country) : playSuggest(prefix, country);

  // Candidate pool, deduped by normalised term.
  const candidates = new Map<string, { term: string; source: string }>();
  const add = (term: string, source: string) => {
    const n = String(term ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (n.length < 3 || n.length > 60) return;
    if (!candidates.has(n)) candidates.set(n, { term: n, source });
  };

  // Phase 1 — autocomplete expansion seeded from the listing's own words.
  await setProgress("Expanding autocomplete…");
  const seedWords = [...new Set(tokens(`${app.name} ${app.subtitle ?? ""}`))].slice(0, MAX_SEEDS);
  for (const country of countries) {
    for (const seed of seedWords) {
      try {
        for (const s of await suggest(seed, country)) add(typeof s === "string" ? s : (s as { term?: string }).term ?? "", "autocomplete");
      } catch {
        /* one dead prefix must not kill the run */
      }
    }
  }

  // Phase 2 — AI candidates, each verified against live autocomplete before it counts.
  if (aiEnabled()) {
    await setProgress("Generating AI candidates…");
    try {
      const competitors = await q<{ name: string; subtitle: string | null; description: string | null }>(
        `select a.name, a.subtitle, a.description from tracked_apps ta join apps a on a.id = ta.app_id
          where ta.competitor_of = $1 and ta.is_active limit 8`,
        [app.tracked_app_id],
      );
      const existing = await q<{ term: string }>(
        `select k.term from tracked_keywords tk join keywords k on k.id = tk.keyword_id where tk.tracked_app_id = $1`,
        [app.tracked_app_id],
      );
      const ideas: string[] = await generateKeywordCandidates({ app, competitors, existing: existing.map((e) => e.term), max: MAX_AI } as never);
      await setProgress(`Verifying ${ideas.length} AI candidates against live autocomplete…`);
      for (const idea of ideas) {
        try {
          const sugg = (await suggest(idea.slice(0, 12), countries[0])).map((s: unknown) => (typeof s === "string" ? s : ((s as { term?: string }).term ?? "")));
          if (verifyCandidate(idea, sugg)) add(idea, "ai");
        } catch {
          /* skip unverifiable */
        }
      }
    } catch (err) {
      await setProgress(`AI phase skipped: ${String((err as Error).message).slice(0, 120)}`);
    }
  }

  // Phase 3 — insert what's genuinely new.
  await setProgress(`Saving ${candidates.size} candidates…`);
  const { appNameBlocklist, isMetadataSafe, looksLikeAppTitle } = await import("@/lib/scoring/listing.mjs");
  const knownApps = await q<{ name: string; developer_name: string | null; store_id: string }>(
    `select name, developer_name, store_id from apps where platform = $1 limit 3000`,
    [app.platform],
  );
  const blocklist = appNameBlocklist(knownApps, app.store_id);

  let found = 0;
  const freshTerms: string[] = [];
  for (const [normalized, { term, source }] of candidates) {
    if (looksLikeAppTitle(term) || blocklist.has(normalized)) continue;
    for (const country of countries) {
      const kw = await upsertKeywordRow({ term, platform: app.platform, country });
      if (!kw) continue;
      const tracked = await q1(`select 1 from tracked_keywords where tracked_app_id = $1 and keyword_id = $2`, [app.tracked_app_id, kw.id]);
      if (tracked) continue;
      const opp = opportunity({ popularity: popularityEffective(kw), difficulty: kw.difficulty, rank: null } as Parameters<typeof opportunity>[0]);
      const res = await q1<{ is_new: boolean }>(
        `insert into discovered_keywords (workspace_id, tracked_app_id, keyword_id, source, opportunity)
         values ($1,$2,$3,$4,$5)
         on conflict (tracked_app_id, keyword_id) do update set opportunity = excluded.opportunity
         returning (xmax = 0) as is_new`,
        [app.workspace_id, app.tracked_app_id, kw.id, source, opp],
      );
      if (res?.is_new) {
        found++;
        if (freshTerms.length < 100) freshTerms.push(term);
      }
      isMetadataSafe(term, { blocklist });
    }
    await exec(`update discovery_runs set found = $2 where id = $1`, [runId, found]);
  }

  // Phase 4 — one relevance batch over the fresh terms so they arrive scored.
  if (aiEnabled() && freshTerms.length) {
    await setProgress(`Scoring relevance for ${freshTerms.length} new terms…`);
    try {
      const scores = await scoreRelevance({ app, terms: [...new Set(freshTerms)] });
      for (const s of scores) {
        await exec(
          `update discovered_keywords dk set relevance = $3, relevance_reason = $4
             from keywords k
            where dk.keyword_id = k.id and dk.tracked_app_id = $1 and k.term = $2`,
          [app.tracked_app_id, s.term, s.relevance, String(s.reason ?? "").slice(0, 200)],
        );
      }
    } catch {
      /* nightly pass will pick these up */
    }
  }

  await exec(`update discovery_runs set status = 'done', progress = 'Done', found = $2, finished_at = now() where id = $1`, [runId, found]);
}
