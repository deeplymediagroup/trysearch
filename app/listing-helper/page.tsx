/**
 * /listing-helper — 01-PRODUCT-SPEC.md §9.
 *
 * 09-BUILD-PLAN.md is explicit here: the keyword-field packer and the metadata-safety checker
 * are PURE CODE and genuinely useful with no AI at all, so they ship first and generation is
 * wired later. This page is the packer, and it costs $0/month to run.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { listKeywords, getLatestSnapshot, getCountries, getLatestListingDraft } from "@/lib/queries";
import { q } from "@/lib/db";
import { generateListing } from "@/app/actions/ai";
import { aiEnabled } from "@/lib/ai";
import { AiButton } from "@/components/AiButton";
import * as fmt from "@/lib/format";
import { packKeywordField, isMetadataSafe, appNameBlocklist, coverageOf, FIELD_LIMITS } from "@/lib/scoring/listing.mjs";
import { popularityEffective } from "@/lib/scoring/scores.mjs";
import { graphemeLength } from "@/lib/scoring/text.mjs";

export const metadata = { title: "Listing Helper — trysearch" };
export const dynamic = "force-dynamic";

export default async function ListingHelperPage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/listing-helper">
        <PageHeader title="Listing Helper" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const countries = await getCountries(active.tracked_app_id);
  const draft = (await getLatestListingDraft(active.tracked_app_id)) as any;
  const [keywords, snapshot, knownApps] = await Promise.all([
    listKeywords(active.tracked_app_id, active.app_id),
    getLatestSnapshot(active.app_id, countries[0] ?? "us") as any,
    q<{ name: string; developer_name: string | null; store_id: string }>(
      `select name, developer_name, store_id from apps where platform = $1 limit 3000`,
      [active.platform],
    ),
  ]);

  const live = {
    app_name: snapshot?.name ?? active.name,
    subtitle: snapshot?.subtitle ?? "",
    keywords_field: null,
    description: snapshot?.description ?? "",
  };

  const blocklist = appNameBlocklist(knownApps, active.store_id);

  // One row per TERM, not per (term, country): the keyword field is written once per locale,
  // so a term tracked in both US and GB must not appear twice. Keep the highest-demand copy.
  const byTerm = new Map<string, (typeof keywords)[number]>();
  for (const k of keywords) {
    const key = k.term.toLowerCase();
    const existing = byTerm.get(key);
    if (!existing || (popularityEffective(k) ?? 0) > (popularityEffective(existing) ?? 0)) byTerm.set(key, k);
  }

  // Score each candidate by demand, and mark the unsafe ones BEFORE packing.
  const candidates = [...byTerm.values()]
    .map((k) => {
      const safety = isMetadataSafe(k.term, { blocklist });
      return {
        term: k.term,
        score: popularityEffective(k) ?? 0,
        metadataSafe: safety.safe,
        reason: safety.reason,
        rank: k.rank,
        difficulty: k.difficulty,
        coverage: coverageOf(k.term, live),
      };
    })
    .sort((a, b) => b.score - a.score);

  const packed = packKeywordField(candidates, live);
  const blocked = candidates.filter((c) => !c.metadataSafe);
  const uncovered = candidates.filter((c) => c.metadataSafe && !c.coverage.covered).slice(0, 12);

  return (
    <AppShell current="/listing-helper">
      <PageHeader
        app={active}
        title="Listing Helper"
        subtitle="Turn your target keywords into an optimized, store-ready listing for your storefront and language."
      />

      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Panel
          title="Keyword field (100 characters)"
          caption="Pure code, no AI. Apple indexes App Name + Subtitle + Keywords as one bag of words, so a word already in your name or subtitle is never repeated here."
        >
          <div className="rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2.5">
            <p className="num break-words text-[12.5px] leading-relaxed">{packed.field || "—"}</p>
          </div>
          <p className="mt-2 flex items-center gap-2 text-[11px] text-[var(--fg-subtle)]">
            <span className="num">{graphemeLength(packed.field)}/{FIELD_LIMITS.keywords_field.limit} characters</span>
            <span>·</span>
            <span>{packed.used.length} words packed</span>
            {packed.skipped.length > 0 && (
              <>
                <span>·</span>
                <span>{packed.skipped.length} did not fit</span>
              </>
            )}
          </p>
          <p className="mt-1 text-[10px] text-[var(--fg-subtle)]">
            Commas with no spaces — a space costs a character and buys nothing.
          </p>

          {packed.used.length > 0 && (
            <div className="mt-3">
              <p className="th mb-1.5">Why each word is here</p>
              <ul className="space-y-1">
                {packed.used.map((w) => (
                  <li key={w} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                    <span className="num text-[var(--fg)]">{w}</span>
                    <span className="truncate text-right text-[var(--fg-muted)]">{(packed.because as any)[w]?.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel
            title="Metadata safety"
            caption="Apple REJECTS listings containing competitor brands, publisher names or people's names. These may be bought as Search Ads keywords, but never indexed."
          >
            {blocked.length === 0 ? (
              <p className="text-[12px] text-[var(--up)]">
                All {candidates.length} tracked keywords are safe to put in indexed metadata.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {blocked.slice(0, 12).map((b) => (
                  <li key={b.term} className="flex items-start justify-between gap-2 text-[11.5px]">
                    <span className="num shrink-0 text-[var(--down)]">{b.term}</span>
                    <span className="text-right text-[var(--fg-muted)]">{b.reason}</span>
                  </li>
                ))}
                {blocked.length > 12 && <li className="text-[11px] text-[var(--fg-subtle)]">…and {blocked.length - 12} more</li>}
              </ul>
            )}
          </Panel>

          <Panel title="Not covered yet" caption="Tracked keywords whose words are missing from your indexed fields. Word-wise, never substring — Apple tokenises.">
            {uncovered.length === 0 ? (
              <p className="text-[12px] text-[var(--fg-muted)]">Every safe tracked keyword is already covered.</p>
            ) : (
              <ul className="space-y-1">
                {uncovered.map((c) => (
                  <li key={c.term} className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="num">{c.term}</span>
                    <span className="flex items-center gap-1">
                      {c.coverage.missing.map((w) => (
                        <Chip key={w} tone="warn">{w}</Chip>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] text-[var(--fg-subtle)]">
              Coverage is a lower bound: the live 100-character keyword field is not readable from any public endpoint,
              so we can only see your App Name and Subtitle.
            </p>
          </Panel>

          <Panel
            title="Generation"
            caption="The only part of this page that costs money. The keyword field in a draft still comes from the pure-code packer."
          >
            {aiEnabled() ? (
              <div className="space-y-3">
                <AiButton
                  label="Generate listing"
                  pendingLabel="Writing listing…"
                  action={generateListing.bind(null, active.tracked_app_id, `${(countries[0] ?? "us").toUpperCase()} · English`, "")}
                />
                {draft && (
                  <div className="space-y-2 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                    <p className="text-[10px] text-[var(--fg-subtle)]">
                      Draft · {draft.locale} · {fmt.relativeDate(draft.created_at)} · {draft.model}
                    </p>
                    {([
                      ["App Name", draft.app_name, 30],
                      ["Subtitle", draft.subtitle, 30],
                      ["Keywords", draft.keywords_field, 100],
                      ["Promotional Text", draft.promotional_text, 170],
                      ["Description", draft.description, 4000],
                    ] as const).map(([label, value, limit]) => (
                      <div key={label}>
                        <p className="th flex items-baseline justify-between">
                          <span>{label}</span>
                          <span className="num text-[10px]">{(value ?? "").length}/{limit}</span>
                        </p>
                        <p className={`whitespace-pre-wrap text-[12px] ${label === "Description" ? "line-clamp-6" : ""}`}>{value || fmt.EM_DASH}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-[var(--fg-muted)]">
                Writing the App Name, Subtitle, Description and Promotional Text needs a language model, so generation
                stays off until <code className="num">ANTHROPIC_API_KEY</code> is set.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
