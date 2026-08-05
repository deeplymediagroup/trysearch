/**
 * /client-reports — a shareable weekly ASO report for the active tracked app: visibility
 * trend, rank movers, top keywords and competitor highlights, all from data the crawler
 * already collected. Single-user tool, so no branding/billing controls from the reference —
 * a Print / PDF button (the browser's own dialog) is the sharing mechanism.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, EmptyState, DeltaBadge, RankPill, CountryFlag, PopularityCell, StalenessNote } from "@/components/ui";
import { StatCard } from "@/components/StatCard";
import { VisibilityChart } from "@/components/Charts";
import { getDailyMetrics, getLatestMetrics, getStaleness, listKeywords, getCompetitors } from "@/lib/queries";
import * as fmt from "@/lib/format";
import { PrintButton } from "./PrintButton";

export const metadata = { title: "Client reports — trysearch" };
export const dynamic = "force-dynamic";

export default async function ClientReportsPage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/client-reports">
        <PageHeader title="Client reports" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first — a report needs data.</EmptyState></div>
      </AppShell>
    );
  }

  const [series, latest, staleness, keywords, competitors] = await Promise.all([
    getDailyMetrics(active.app_id, 30),
    getLatestMetrics(active.app_id),
    getStaleness(active.app_id),
    listKeywords(active.tracked_app_id, active.app_id),
    getCompetitors(active.tracked_app_id),
  ]);

  const prev7 = [...series].reverse().find((r: any) => r.visibility != null && new Date(r.metric_on) <= new Date(Date.now() - 7 * 86_400_000)) as any;
  const visibilityDelta =
    latest?.visibility != null && prev7?.visibility != null ? Math.round(Number(latest.visibility) - Number(prev7.visibility)) : null;

  const movers = keywords.filter((k) => k.delta_7d != null && k.delta_7d !== 0);
  const gainers = [...movers].sort((a, b) => (b.delta_7d ?? 0) - (a.delta_7d ?? 0)).slice(0, 5);
  const losers = [...movers].sort((a, b) => (a.delta_7d ?? 0) - (b.delta_7d ?? 0)).slice(0, 5);
  const topKeywords = keywords.filter((k) => k.rank != null).sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999)).slice(0, 10);

  const moverRow = (k: (typeof keywords)[number]) => (
    <li key={k.tracked_keyword_id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
      <span className="min-w-0 flex-1 truncate">{k.term}</span>
      <CountryFlag country={k.country} showCode={false} />
      <RankPill state={{ rank: k.rank, found: k.found ?? false, last_known_rank: k.last_known_rank, crawl_depth: k.crawl_depth }} />
      <span className="w-12 text-right"><DeltaBadge value={k.delta_7d} /></span>
    </li>
  );

  return (
    <AppShell current="/client-reports">
      {/* The shell is chrome, not report: hide it when this page goes to paper. */}
      <style>{`@media print { aside { display: none !important } main { padding: 0 } }`}</style>

      <PageHeader
        app={active}
        title={active.name}
        subtitle={<>Weekly ASO report · {fmt.shortDate(new Date())}</>}
        actions={<PrintButton />}
      />

      <div className="space-y-4 p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Visibility"
            value={fmt.score(latest?.visibility == null ? null : Number(latest.visibility))}
            delta={<DeltaBadge value={visibilityDelta} />}
            sub="0–100, vs 7 days ago"
          />
          <StatCard label="Ranked keywords" value={fmt.count(latest?.ranked_count == null ? null : Number(latest.ranked_count))} sub={`of ${fmt.count(keywords.length)} tracked`} />
          <StatCard label="Top 10 rankings" value={fmt.count(latest?.top10_count == null ? null : Number(latest.top10_count))} sub={`${fmt.count(latest?.top3_count == null ? null : Number(latest.top3_count))} in the top 3`} />
          <StatCard
            label="Best rank"
            value={latest?.best_rank == null ? null : `#${latest.best_rank}`}
            sub={latest?.best_rank_term ? `“${latest.best_rank_term}”` : undefined}
          />
        </div>

        <Panel title="Visibility trend" caption="Popularity-weighted rank reach, last 30 days.">
          <VisibilityChart data={series as { metric_on: string; visibility: number | null }[]} />
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Movers up" caption="Biggest rank improvements, last 7 days.">
            {gainers.length ? <ul className="divide-y divide-[var(--border)]">{gainers.map(moverRow)}</ul>
              : <p className="py-6 text-center text-[12px] text-[var(--fg-subtle)]">No keyword improved this week.</p>}
          </Panel>
          <Panel title="Movers down" caption="Biggest rank drops, last 7 days.">
            {losers.length ? <ul className="divide-y divide-[var(--border)]">{losers.map(moverRow)}</ul>
              : <p className="py-6 text-center text-[12px] text-[var(--fg-subtle)]">No keyword dropped this week.</p>}
          </Panel>
        </div>

        <Panel title="Top keywords" caption="Best current positions across tracked keywords.">
          {topKeywords.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-[var(--fg-subtle)]">No ranked keywords yet.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th scope="col" className="th px-3 py-2 text-left">Keyword</th>
                  <th scope="col" className="th px-3 py-2 text-left">Country</th>
                  <th scope="col" className="th px-3 py-2 text-left">Rank</th>
                  <th scope="col" className="th px-3 py-2 text-left">Popularity</th>
                  <th scope="col" className="th px-3 py-2 text-right">Δ7d</th>
                </tr>
              </thead>
              <tbody>
                {topKeywords.map((k) => (
                  <tr key={k.tracked_keyword_id} className="border-b border-[var(--border)]">
                    <td className="px-3 py-2">{k.term}</td>
                    <td className="px-3 py-2"><CountryFlag country={k.country} /></td>
                    <td className="px-3 py-2">
                      <RankPill state={{ rank: k.rank, found: k.found ?? false, last_known_rank: k.last_known_rank, crawl_depth: k.crawl_depth }} />
                    </td>
                    <td className="px-3 py-2"><PopularityCell keyword={k} /></td>
                    <td className="px-3 py-2 text-right"><DeltaBadge value={k.delta_7d} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Competitor highlights" caption="Tracked competitors, latest store snapshot.">
          {competitors.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-[var(--fg-subtle)]">No competitors tracked yet.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th scope="col" className="th px-3 py-2 text-left">App</th>
                  <th scope="col" className="th px-3 py-2 text-left">Rating</th>
                  <th scope="col" className="th px-3 py-2 text-left">Version</th>
                  <th scope="col" className="th px-3 py-2 text-right">Est. revenue</th>
                </tr>
              </thead>
              <tbody>
                {competitors.map((c: any) => (
                  <tr key={c.tracked_app_id} className="border-b border-[var(--border)]">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {c.icon_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.icon_url} alt="" width={20} height={20} className="h-5 w-5 rounded-[5px]" />
                        )}
                        <span className="truncate">{c.name}</span>
                      </span>
                    </td>
                    <td className="num px-3 py-2">
                      {fmt.rating(c.rating_average == null ? null : Number(c.rating_average))}
                      {c.rating_count != null && <span className="text-[var(--fg-subtle)]"> ({fmt.count(Number(c.rating_count))})</span>}
                    </td>
                    <td className="num px-3 py-2">{c.version ?? fmt.EM_DASH}</td>
                    <td className="num px-3 py-2 text-right">{c.revenue_display ?? fmt.EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <StalenessNote date={staleness} />
      </div>
    </AppShell>
  );
}
