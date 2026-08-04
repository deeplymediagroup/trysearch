/**
 * /competitors — 01-PRODUCT-SPEC.md §4. Three tabs.
 *
 * The competitive-position buckets are computed in the rollup job using the PUBLISHED
 * thresholds (03 §7), so this page is a single indexed read of competitive_positions.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, RankPill, ScoreCell, PopularityCell, CountryFlag, Chip, EmptyState, StalenessNote, EstimateLegend } from "@/components/ui";
import { getCompetitors, getCompetitivePositions, getStaleness, getAiAnalyses, getSuggestedCompetitors, getCompareData } from "@/lib/queries";
import { generateLandscape } from "@/app/actions/ai";
import { addSuggestedCompetitor, addAllSuggestedCompetitors, dismissCompetitorSuggestion, scanCompetitorNow } from "@/app/actions/apps";
import { trackTermsFromAnalysis } from "@/app/actions/keywords";
import { aiEnabled } from "@/lib/ai";
import { AiButton } from "@/components/AiButton";
import { AddAppDialog } from "@/components/AddDialog";
import { RemoveCompetitorButton } from "@/components/UntrackButtons";
import * as fmt from "@/lib/format";

export const metadata = { title: "Competitors — trysearch" };
export const dynamic = "force-dynamic";

const BUCKETS = [
  { id: "gap", label: "Keyword gaps", hint: "A competitor ranks for it, you don't." },
  { id: "winnable", label: "Winnable now", hint: "A gap where difficulty is low enough to realistically take." },
  { id: "threat", label: "Threats", hint: "A competitor climbed into the top 20 against you." },
  { id: "lead", label: "You lead", hint: "You outrank every tracked competitor." },
];

export default async function CompetitorsPage({ searchParams }: { searchParams: Promise<{ tab?: string; bucket?: string; compare?: string }> }) {
  const { tab = "competitors", bucket, compare } = await searchParams;
  const { active } = await getActiveApp();

  if (!active) {
    return (
      <AppShell current="/competitors">
        <PageHeader title="Competitors" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const [competitors, positions, staleness, analyses, suggestions] = await Promise.all([
    getCompetitors(active.tracked_app_id),
    getCompetitivePositions(active.tracked_app_id),
    getStaleness(active.app_id),
    getAiAnalyses(active.tracked_app_id),
    active.role === "own" ? getSuggestedCompetitors(active.workspace_id, active) : Promise.resolve([]),
  ]);

  const counts = Object.fromEntries(BUCKETS.map((b) => [b.id, positions.filter((p: any) => p.bucket === b.id).length]));
  const shown = bucket ? positions.filter((p: any) => p.bucket === bucket) : positions;

  const comparison =
    compare && competitors.some((c: any) => c.app_id === compare)
      ? await getCompareData(active.app_id, compare, active.tracked_app_id)
      : null;

  return (
    <AppShell current="/competitors">
      <PageHeader
        app={active}
        title="Competitors"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{active.device ?? "iphone"} · {competitors.length} competitors</span>
            <StalenessNote date={staleness} />
          </span>
        }
        actions={
          active.role === "own" ? (
            <AddAppDialog role="competitor" competitorOf={active.tracked_app_id} label="+ Add competitor" />
          ) : null
        }
      />

      <nav className="flex gap-1 border-b border-[var(--border)] px-6" aria-label="Competitor tabs">
        {[
          { id: "competitors", label: "Competitors", n: competitors.length },
          { id: "position", label: "Competitive position", n: positions.length },
          { id: "ai", label: "AI analyses", n: analyses.length },
        ].map((t) => (
          <Link
            key={t.id}
            href={`/competitors?tab=${t.id}`}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] ${tab === t.id ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
          >
            {t.label} <span className="num text-[var(--fg-subtle)]">{t.n}</span>
          </Link>
        ))}
      </nav>

      <div className="p-6">
        {comparison?.own && comparison?.rival && (
          <Panel
            className="mb-4"
            title={`${comparison.own.name} vs ${comparison.rival.name}`}
            caption="Side-by-side listing and every shared keyword measurement, sorted by where they beat you hardest."
            action={<Link href="/competitors" className="text-[12px] text-[var(--fg-subtle)] hover:text-[var(--fg)]">✕ Close</Link>}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              {[comparison.own, comparison.rival].map((a: any, i) => (
                <div key={a.id} className={i === 1 ? "lg:border-l lg:border-[var(--border)] lg:pl-4" : ""}>
                  <div className="flex items-center gap-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {a.icon_url && <img src={a.icon_url} alt="" width={36} height={36} className="rounded-[9px]" />}
                    <div>
                      <p className="text-[14px] font-semibold">{a.name} {i === 0 && <Chip tone="branded">You</Chip>}</p>
                      <p className="text-[12px] text-[var(--fg-muted)]">{a.subtitle ?? fmt.EM_DASH}</p>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-[12px]">
                    {[
                      ["Developer", a.developer_name ?? fmt.EM_DASH],
                      ["Version", a.version ?? fmt.EM_DASH],
                      ["Rating", `★ ${fmt.rating(a.rating_average)} (${fmt.count(a.rating_count)})`],
                      ["Est. revenue", a.revenue_display ? `${a.revenue_display} · ${a.revenue_model ?? ""}` : fmt.EM_DASH],
                    ].map(([label, value]) => (
                      <div key={label as string} className="flex justify-between gap-3">
                        <dt className="text-[var(--fg-subtle)]">{label}</dt>
                        <dd className="num text-right">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            {comparison.shared.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {["Keyword", "Market", "Popularity", "Difficulty", "Your rank", "Their rank"].map((h) => (
                        <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.shared.slice(0, 30).map((s: any) => (
                      <tr key={`${s.term}-${s.country}`} className="border-b border-[var(--border)]">
                        <td className="px-3 py-1.5 font-medium">{s.term}</td>
                        <td className="px-3 py-1.5"><CountryFlag country={s.country} /></td>
                        <td className="px-3 py-1.5"><PopularityCell keyword={s} /></td>
                        <td className="px-3 py-1.5"><ScoreCell value={s.difficulty} /></td>
                        <td className="px-3 py-1.5"><RankPill state={{ rank: s.my_rank, found: s.my_rank != null, checked: true }} /></td>
                        <td className="px-3 py-1.5"><RankPill state={{ rank: s.their_rank, found: s.their_rank != null, checked: true }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "competitors" && suggestions.length > 0 && (
          <Panel
            title="Suggested competitors"
            caption="Computed from data already collected — apps ranking on your tracked keywords, plus the store's similar-apps shelf. Adding one immediately scans its keyword footprint."
          >
            <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((s) => (
                <div key={`${s.platform}:${s.store_id}`} className="flex items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {s.icon_url && <img src={s.icon_url} alt="" width={20} height={20} className="rounded-[5px]" />}
                    <span className="min-w-0">
                      <span className="num block truncate text-[12.5px]">{s.name ?? `(app ${s.store_id})`}</span>
                      <span className="block text-[11px] text-[var(--fg-subtle)]">
                        {s.reason === "serp" ? <>Ranks on <span className="num">{s.overlap}</span> of your keywords</> : "On your similar-apps shelf"}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <AiButton label="Add" pendingLabel="Adding…" action={addSuggestedCompetitor.bind(null, active.tracked_app_id, s.platform, s.store_id)} />
                    <AiButton label="✕" pendingLabel="…" action={dismissCompetitorSuggestion.bind(null, s.platform, s.store_id)} />
                  </span>
                </div>
              ))}
            </div>
            {suggestions.length > 1 && (
              <AiButton
                label={`Add all ${suggestions.length}`}
                pendingLabel="Adding all…"
                action={addAllSuggestedCompetitors.bind(null, active.tracked_app_id, suggestions.map((s) => ({ store: s.platform, storeId: s.store_id })))}
              />
            )}
          </Panel>
        )}

        {tab === "competitors" && (
          <Panel caption="Your own app is pinned first. Install counts come from Play; Apple exposes none at any price.">
            {competitors.length === 0 ? (
              <EmptyState
                title="No competitors tracked"
                action={active.role === "own" ? <AddAppDialog role="competitor" competitorOf={active.tracked_app_id} label="+ Add competitor" /> : null}
              >
                An empty landscape, not an error. Paste a competitor&apos;s store link, id or name.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {["App", "Developer", "Version", "Rating", "Reviews", "Installs", "Est. Revenue", ""].map((h) => (
                        <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--border)] bg-[var(--bg-panel)]">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          {active.icon_url && <img src={active.icon_url} alt="" width={20} height={20} className="rounded-[5px]" />}
                          <span className="num">{active.name}</span>
                          <Chip tone="branded">Your app</Chip>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[var(--fg-muted)]">{active.developer_name ?? fmt.EM_DASH}</td>
                      <td className="num px-3 py-2">{active.version ?? fmt.EM_DASH}</td>
                      <td className="num px-3 py-2">★ {fmt.rating(active.rating_average)}</td>
                      <td className="num px-3 py-2">{fmt.count(active.rating_count)}</td>
                      <td className="num px-3 py-2 text-[var(--fg-subtle)]">{fmt.EM_DASH}</td>
                      <td className="num px-3 py-2 text-[var(--fg-subtle)]">{fmt.EM_DASH}</td>
                      <td />
                    </tr>
                    {competitors.map((c: any) => (
                      <tr key={c.app_id} className="border-b border-[var(--border)]">
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            {c.icon_url && <img src={c.icon_url} alt="" width={20} height={20} className="rounded-[5px]" />}
                            <span className="num">{c.name}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[var(--fg-muted)]">{c.developer_name ?? fmt.EM_DASH}</td>
                        <td className="num px-3 py-2">
                          {c.version ?? fmt.EM_DASH}
                          {c.version_released_at && <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">{fmt.relativeDate(c.version_released_at)}</span>}
                        </td>
                        <td className="num px-3 py-2">★ {fmt.rating(c.rating_average)}</td>
                        <td className="num px-3 py-2">{fmt.count(c.rating_count)}</td>
                        <td className="num px-3 py-2">{fmt.installs(c.install_count)}</td>
                        <td className="num px-3 py-2">
                          {c.revenue_display ?? fmt.EM_DASH}
                          {c.revenue_confidence && <span className="ml-1 text-[10px] text-[var(--fg-subtle)]">{c.revenue_confidence}</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-2">
                            {aiEnabled() && (
                              <AiButton label="Scan (AI)" pendingLabel="Scanning…" action={scanCompetitorNow.bind(null, c.tracked_app_id)} />
                            )}
                            <Link href={`/competitors?compare=${c.app_id}`} className="text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">Compare</Link>
                            <RemoveCompetitorButton trackedAppId={c.tracked_app_id} name={c.name} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "position" && (
          <div className="space-y-3">
            <p className="text-[12px] text-[var(--fg-muted)]">Live comparison across your tracked keywords — updated with every rank check.</p>

            <div className="flex flex-wrap gap-2">
              {BUCKETS.map((b) => (
                <Link
                  key={b.id}
                  href={`/competitors?tab=position${bucket === b.id ? "" : `&bucket=${b.id}`}`}
                  title={b.hint}
                  className={`rounded-[var(--radius-chip)] border px-2.5 py-1 text-[12px] ${bucket === b.id ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}
                >
                  {b.label} <span className="num">{counts[b.id] ?? 0}</span>
                </Link>
              ))}
            </div>

            <Panel caption="Thresholds: a gap needs a competitor in the top 30; winnable additionally needs difficulty ≤40 and popularity ≥20; a threat is a climb of ≥5 into the top 20; a lead is your top-10 position ahead of everyone.">
              {shown.length === 0 ? (
                <EmptyState title="Nothing in this bucket">
                  {competitors.length ? "Run the crawler again after a day or two so movement can be measured." : "Add a competitor to populate the landscape."}
                </EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-[var(--border)]">
                        {["Keyword", "Country", "Best competitor", "Theirs", "Yours", "Popularity", "Difficulty", "Opp.", "Bucket"].map((h) => (
                          <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.slice(0, 25).map((p: any, i: number) => (
                        <tr key={i} className="border-b border-[var(--border)]">
                          <td className="num px-3 py-2">{p.term}</td>
                          <td className="px-3 py-2"><CountryFlag country={p.country} /></td>
                          <td className="px-3 py-2 text-[var(--fg-muted)]">{p.competitor_name ?? fmt.EM_DASH}</td>
                          <td className="num px-3 py-2">{p.their_rank ? `#${p.their_rank}` : fmt.EM_DASH}</td>
                          <td className="num px-3 py-2">{p.our_rank ? `#${p.our_rank}` : fmt.DOUBLE_DASH}</td>
                          <td className="px-3 py-2"><PopularityCell keyword={p} /></td>
                          <td className="px-3 py-2"><ScoreCell value={p.difficulty} label="Difficulty" /></td>
                          <td className="px-3 py-2"><ScoreCell value={p.opportunity} label="Opportunity" tone="var(--accent)" /></td>
                          <td className="px-3 py-2"><Chip tone={p.bucket === "lead" ? "beatable" : p.bucket === "threat" ? "warn" : "neutral"}>{p.bucket}</Chip></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">Top {Math.min(25, shown.length)} of {shown.length}, sorted by opportunity.</p>
                </div>
              )}
            </Panel>
            <EstimateLegend />
          </div>
        )}

        {tab === "ai" && (
          <div className="space-y-4">
            {aiEnabled() ? (
              <div className="flex items-center justify-between">
                <p className="text-[12px] text-[var(--fg-muted)]">
                  On-demand competitive report, grounded in your tracked keywords. At most one per app per 7 days.
                </p>
                <AiButton label="Generate analysis" pendingLabel="Analyzing landscape…" action={generateLandscape.bind(null, active.tracked_app_id)} />
              </div>
            ) : (
              <Panel caption="Optional feature.">
                <EmptyState title="AI analyses are not enabled">
                  Competitive analyses need a language model, so they are off until{" "}
                  <code className="num">ANTHROPIC_API_KEY</code> is set.
                </EmptyState>
              </Panel>
            )}

            {analyses.length === 0 && aiEnabled() && (
              <Panel>
                <EmptyState title="No analyses yet">Generate the first one — every report is stored and stays readable here.</EmptyState>
              </Panel>
            )}

            {analyses.map((a: any) => (
              <Panel key={a.id} title={`Analysis · ${fmt.shortDate(a.created_at)}`} caption={`Model: ${a.model}`}>
                <p className="mb-3 text-[12.5px] leading-relaxed">{a.posture}</p>
                {Array.isArray(a.changes) && a.changes.length > 0 && (
                  <div className="mb-3 rounded border border-[var(--border)] bg-[var(--bg-panel)] p-3">
                    <p className="th mb-1.5">What changed since the previous run</p>
                    <ul className="space-y-2">
                      {(a.changes as { title: string; detail: string }[]).map((item) => (
                        <li key={item.title} className="text-[12px]">
                          <p className="font-medium">{item.title}</p>
                          <p className="text-[var(--fg-muted)]">{item.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="grid gap-3 lg:grid-cols-3">
                  {([["opportunities", "Opportunities"], ["threats", "Threats"], ["strengths", "Strengths"]] as const).map(([key, label]) => (
                    <div key={key}>
                      <p className="th mb-1.5">{label}</p>
                      <ul className="space-y-2">
                        {((a[key] ?? []) as { title: string; detail: string; keywords?: string[] }[]).map((item) => (
                          <li key={item.title} className="text-[12px]">
                            <p className="font-medium">{item.title}</p>
                            <p className="text-[var(--fg-muted)]">{item.detail}</p>
                            {key === "opportunities" && (item.keywords?.length ?? 0) > 0 && (
                              <p className="mt-1">
                                <span className="num text-[11px] text-[var(--fg-subtle)]">{item.keywords!.join(", ")} </span>
                                <AiButton
                                  label={`Track all (${item.keywords!.length})`}
                                  pendingLabel="Tracking…"
                                  action={trackTermsFromAnalysis.bind(null, active.tracked_app_id, item.keywords!)}
                                />
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
