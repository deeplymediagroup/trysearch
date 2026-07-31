/**
 * /competitors — 01-PRODUCT-SPEC.md §4. Three tabs.
 *
 * The competitive-position buckets are computed in the rollup job using the PUBLISHED
 * thresholds (03 §7), so this page is a single indexed read of competitive_positions.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, RankPill, ScoreCell, PopularityCell, CountryFlag, Chip, EmptyState, StalenessNote, EstimateLegend } from "@/components/ui";
import { getCompetitors, getCompetitivePositions, getStaleness } from "@/lib/queries";
import * as fmt from "@/lib/format";

export const metadata = { title: "Competitors — trysearch" };
export const dynamic = "force-dynamic";

const BUCKETS = [
  { id: "gap", label: "Keyword gaps", hint: "A competitor ranks for it, you don't." },
  { id: "winnable", label: "Winnable now", hint: "A gap where difficulty is low enough to realistically take." },
  { id: "threat", label: "Threats", hint: "A competitor climbed into the top 20 against you." },
  { id: "lead", label: "You lead", hint: "You outrank every tracked competitor." },
];

export default async function CompetitorsPage({ searchParams }: { searchParams: Promise<{ tab?: string; bucket?: string }> }) {
  const { tab = "competitors", bucket } = await searchParams;
  const { active } = await getActiveApp();

  if (!active) {
    return (
      <AppShell current="/competitors">
        <PageHeader title="Competitors" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const [competitors, positions, staleness] = await Promise.all([
    getCompetitors(active.tracked_app_id),
    getCompetitivePositions(active.tracked_app_id),
    getStaleness(active.app_id),
  ]);

  const counts = Object.fromEntries(BUCKETS.map((b) => [b.id, positions.filter((p: any) => p.bucket === b.id).length]));
  const shown = bucket ? positions.filter((p: any) => p.bucket === bucket) : positions;

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
          <span className="text-[11px] text-[var(--fg-subtle)]">
            Add one with <code className="num">seed-app.mjs --competitor &lt;id&gt;</code>
          </span>
        }
      />

      <nav className="flex gap-1 border-b border-[var(--border)] px-6" aria-label="Competitor tabs">
        {[
          { id: "competitors", label: "Competitors", n: competitors.length },
          { id: "position", label: "Competitive position", n: positions.length },
          { id: "ai", label: "AI analyses", n: 0 },
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
        {tab === "competitors" && (
          <Panel caption="Your own app is pinned first. Install counts come from Play; Apple exposes none at any price.">
            {competitors.length === 0 ? (
              <EmptyState title="No competitors tracked">
                An empty landscape, not an error. Add one with{" "}
                <code className="num">node scripts/seed-app.mjs --ios {active.store_id} --competitor &lt;their id&gt;</code>
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {["App", "Developer", "Version", "Rating", "Reviews", "Installs", "Est. Revenue"].map((h) => (
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
          <Panel caption="Optional feature.">
            <EmptyState title="AI analyses are not enabled">
              Every other number in this product costs $0/month. Competitive analyses need a language model, so they are
              off until <code className="num">ANTHROPIC_API_KEY</code> is set. The four buckets above are computed from
              public store data with no AI at all.
            </EmptyState>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
