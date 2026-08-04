"use server";

/**
 * Research projects (Workstream J) — standalone keyword research without polluting tracked
 * apps. Keywords land in the SHARED keywords table, so the on-demand metrics pass (G) and
 * the nightly crawl score them once for everyone; a project is just a named set of pointers.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { q, q1, exec, currentWorkspace } from "@/lib/db";
import { addKeywords } from "@/app/actions/keywords";

async function workspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace. Run `npm run db:migrate`.");
  return ws.id;
}

export async function createResearchProject(name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) return { error: "Give the project a name." };
  const ws = await workspaceId();
  const row = await q1<{ id: string }>(
    `insert into research_projects (workspace_id, name) values ($1,$2) returning id`,
    [ws, clean],
  );
  revalidatePath("/research");
  return { ok: true, id: row!.id };
}

export async function deleteResearchProject(projectId: string) {
  const ws = await workspaceId();
  // Cascade removes only the project's POINTERS; keywords and their metrics survive (05 §2.5).
  await exec(`delete from research_projects where id = $1 and workspace_id = $2`, [projectId, ws]);
  revalidatePath("/research");
  return { ok: true };
}

/** Compute metrics after the response for keywords that still miss them — same pattern as addKeywords. */
function scheduleMetrics(entries: { term: string; platform: string; country: string }[]) {
  after(async () => {
    const { liveKeywordMetrics, ensureFetchSink, normalizeTerm } = await import("@/lib/serp.mjs");
    ensureFetchSink(q);
    const deadline = Date.now() + 240_000;
    for (const e of entries) {
      if (Date.now() > deadline) return;
      try {
        const row = await q1<{ difficulty: number | null; popularity_estimate: number | null }>(
          `select difficulty, popularity_estimate from keywords
            where term_normalized = $1 and platform = $2 and country = $3`,
          [normalizeTerm(e.term), e.platform, e.country],
        );
        if (row && row.difficulty != null && row.popularity_estimate != null) continue;
        await liveKeywordMetrics(q, { term: e.term, platform: e.platform, country: e.country });
      } catch {
        // nightly crawl picks up stragglers
      }
    }
  });
}

export async function addResearchKeywords(projectId: string, terms: string[], stores: ("ios" | "android")[], countries: string[]) {
  const ws = await workspaceId();
  const project = await q1(`select id from research_projects where id = $1 and workspace_id = $2`, [projectId, ws]);
  if (!project) return { error: "Unknown project for this workspace." };
  if (!stores.length || !countries.length) return { error: "Pick at least one store and one country." };

  const unique = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 60))];
  let added = 0;
  const queued: { term: string; platform: string; country: string }[] = [];

  for (const term of unique) {
    for (const platform of stores) {
      for (const country of countries) {
        const normalized = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
        const kw = await q1<{ id: string }>(
          `insert into keywords (term, term_normalized, platform, country, word_count)
           values ($1,$2,$3,$4,$5)
           on conflict (term_normalized, platform, country) do update set term = keywords.term
           returning id`,
          [term, normalized, platform, country, normalized.split(/\s+/).length],
        );
        const res = await q(
          `insert into research_keywords (project_id, keyword_id) values ($1,$2)
           on conflict (project_id, keyword_id) do nothing returning id`,
          [projectId, kw!.id],
        );
        if (res.length) added++;
        queued.push({ term, platform, country });
      }
    }
  }

  scheduleMetrics(queued.slice(0, 50));
  revalidatePath("/research");
  return { ok: true, added };
}

/**
 * Seed a project from an app: its ranked keywords from our SERP corpus (any app that appears
 * in a stored SERP top-30 has "ranked keywords" for free), topped up with its listing terms.
 */
export async function seedFromApp(projectId: string, store: "ios" | "android", storeId: string, country: string) {
  const ws = await workspaceId();
  const project = await q1(`select id from research_projects where id = $1 and workspace_id = $2`, [projectId, ws]);
  if (!project) return { error: "Unknown project for this workspace." };

  // 1. Ranked keywords we already observed for this app — measured, zero fetches.
  const ranked = await q<{ term: string }>(
    `select distinct k.term
       from serp_results r
       join apps a on a.id = r.app_id
       join keywords k on k.id = r.keyword_id
      where a.platform = $1 and a.store_id = $2 and k.country = $3
        and r.position <= 30 and r.captured_on > current_date - 30
      limit 100`,
    [store, storeId, country],
  );

  // 2. Listing terms, fetched live.
  let listingTerms: string[] = [];
  try {
    if (store === "ios") {
      const { appleAppSSR } = await import("@/lib/stores/apple.mjs");
      const ssr = await appleAppSSR(storeId, country);
      const { bigrams } = await import("@/lib/competitor-scan.mjs");
      listingTerms = bigrams(`${ssr?.name ?? ""} ${ssr?.subtitle ?? ""}`);
    } else {
      const { playAppDetail, extractListingKeywords } = await import("@/lib/stores/play.mjs");
      const d = await playAppDetail(storeId, country);
      if (d) listingTerms = extractListingKeywords({ name: d.name, subtitle: d.summary, description: d.description }, { max: 25 }).map((k: any) => k.term);
    }
  } catch {
    // ranked keywords alone are still a useful seed
  }

  const terms = [...new Set([...ranked.map((r) => r.term), ...listingTerms])].slice(0, 120);
  if (!terms.length) return { error: "Nothing to seed — the app has no observed rankings and its listing gave no terms." };

  return addResearchKeywords(projectId, terms, [store], [country]);
}

/** Push selected research keywords into a tracked app (store-matched by the caller's picker). */
export async function pushToApp(trackedAppId: string, terms: string[], countries: string[]) {
  if (!terms.length) return { error: "Select keywords first." };
  const res = await addKeywords(trackedAppId, terms, countries);
  revalidatePath("/research");
  return { ok: true, added: res.added };
}
