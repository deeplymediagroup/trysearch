/**
 * /keywords/k/[id] — the per-keyword detail page: metrics with breakdowns, Beatable
 * evidence, 30-day trend for you AND your competitors, and the latest captured SERP.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState, CountryFlag, ScoreCell, PopularityCell, RankPill, DeltaBadge } from "@/components/ui";
import { RankHistoryChart } from "@/components/Charts";
import { getKeywordDetail } from "@/lib/queries";
import { keywordSeasonality } from "@/lib/stores/gtrends.mjs";
import { q1 } from "@/lib/db";
import * as fmt from "@/lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const metadata = { title: "Keyword — trysearch" };
export const dynamic = "force-dynamic";

export default async function KeywordDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ active }, detail] = await Promise.all([getActiveApp(), getKeywordDetail(id)]);

  if (!detail) {
    return (
      <AppShell current="/keywords">
        <PageHeader title="Keyword not found" />
        <div className="p-6">
          <EmptyState title="This keyword is no longer tracked" action={<Link href="/keywords" className="text-[12px] text-[var(--accent)]">← Back to Keywords</Link>} />
        </div>
      </AppShell>
    );
  }

  const { kw, history, serp } = detail;
  // Real 5-year Google Trends seasonality, cached 7 days. Null = Trends had no signal.
  const seasonality = (await keywordSeasonality(q1, kw.term, kw.country.toUpperCase()).catch(() => null)) as
    | { index: number[]; peaks: string[]; troughs: string[]; seasonal: boolean; weeks: number }
    | null;
  const beatable = (kw.difficulty_parts as any)?.beatable_value === true;
  const beatableReason = (kw.difficulty_parts as any)?.beatable?.reason as string | undefined;

  // One chart series per app that has any measurement on this keyword.
  const byApp = new Map<string, { term: string; country: string; points: { date: string; rank: number | null }[] }>();
  for (const h of history) {
    const label = h.role === "own" ? h.app_name : `${h.app_name} (rival)`;
    if (!byApp.has(label)) byApp.set(label, { term: label, country: kw.country, points: [] });
    byApp.get(label)!.points.push({ date: h.checked_on, rank: h.rank });
  }

  return (
    <AppShell current="/keywords">
      <PageHeader
        app={active ?? undefined}
        title={kw.term}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <CountryFlag country={kw.country} />
            <Chip>{kw.platform === "ios" ? "App Store" : "Google Play"}</Chip>
            <Chip tone={kw.is_branded ? "branded" : "neutral"}>{kw.is_branded ? "Branded" : "Generic"}</Chip>
            {beatable && <Chip tone="beatable" title={beatableReason}>Beatable</Chip>}
            {kw.serp_outlier && <Chip tone="warn">Outlier</Chip>}
            {kw.note && <span className="text-[12px] text-[var(--fg-muted)]">📝 {kw.note}</span>}
          </span>
        }
        actions={<Link href="/keywords" className="h-8 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] leading-8 text-[var(--fg-muted)] hover:text-[var(--fg)]">← All keywords</Link>}
      />

      <div className="grid gap-4 p-6 xl:grid-cols-3">
        <Panel title="Metrics" caption={kw.metrics_updated_at ? `Measured ${fmt.relativeDate(kw.metrics_updated_at)}` : "Not measured yet"}>
          <dl className="space-y-2.5">
            <Row label="Rank"><RankPill state={{ rank: kw.rank, found: kw.found ?? false, last_known_rank: kw.last_known_rank, checked: kw.checked_at != null }} /></Row>
            <Row label="Popularity"><PopularityCell keyword={kw} /></Row>
            <Row label="Difficulty"><ScoreCell value={kw.difficulty} parts={kw.difficulty_parts} label="Difficulty breakdown" tone="var(--warn)" /></Row>
            <Row label="Gap"><DeltaBadge value={kw.gap} /></Row>
            <Row label="Best rank"><span className="num text-[12px]">{kw.best_rank == null ? fmt.EM_DASH : `#${kw.best_rank}`}</span></Row>
            <Row label="7-day avg"><span className="num text-[12px]">{kw.avg_7d == null ? fmt.EM_DASH : `#${Math.round(Number(kw.avg_7d))}`}</span></Row>
            <Row label="Est. #1 downloads/day">
              <span className="num text-[12px]" title="Modelled, order of magnitude only.">{kw.est_downloads_rank1 == null ? fmt.EM_DASH : `~${fmt.count(kw.est_downloads_rank1)}`}</span>
            </Row>
          </dl>
          {beatable && beatableReason && (
            <p className="mt-3 rounded-[var(--radius-chip)] bg-[rgba(22,163,74,0.08)] p-2.5 text-[12px] text-[var(--up)]">{beatableReason}</p>
          )}
        </Panel>

        <div className="xl:col-span-2">
          <Panel title="30-day rank trend" caption="You and every tracked competitor on this keyword. Gaps are unmeasured days.">
            <RankHistoryChart series={[...byApp.values()]} annotations={[]} />
          </Panel>
        </div>

        <div className="xl:col-span-3">
          <Panel
            title="Seasonality"
            caption={
              seasonality
                ? `Google Trends, ${Math.round(seasonality.weeks / 52)} years of weekly interest. 100 = this term's own average.`
                : "Google Trends had no reliable signal for this term (too little search volume)."
            }
          >
            {seasonality ? (
              <div>
                <div className="flex items-end gap-1.5">
                  {seasonality.index.map((v, i) => (
                    <div key={MONTHS[i]} className="flex flex-1 flex-col items-center gap-1" title={`${MONTHS[i]}: ${v}`}>
                      <div className="flex h-20 w-full items-end">
                        <div
                          className="w-full rounded-t-[3px]"
                          style={{
                            height: `${Math.max(4, Math.min(100, (v / Math.max(...seasonality.index)) * 100))}%`,
                            background: v >= 120 ? "var(--up)" : v <= 80 ? "var(--down)" : "var(--border-strong)",
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-[var(--fg-subtle)]">{MONTHS[i]}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--fg-muted)]">
                  {seasonality.seasonal ? (
                    <>
                      <Chip tone="warn">Seasonal</Chip>
                      {seasonality.peaks.length > 0 && <span>Peaks in {seasonality.peaks.join(", ")}.</span>}
                      {seasonality.troughs.length > 0 && <span>Quietest in {seasonality.troughs.join(", ")}.</span>}
                    </>
                  ) : (
                    <>
                      <Chip>Steady</Chip>
                      <span>Demand is roughly flat across the year.</span>
                    </>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-[12px] text-[var(--fg-subtle)]">{fmt.EM_DASH}</p>
            )}
          </Panel>
        </div>

        <div className="xl:col-span-3">
          <Panel title="Latest search results" caption="The most recent captured SERP for this keyword. Title match means the app name contains every query word.">
            {serp.length === 0 ? (
              <EmptyState title="No SERP captured yet">The nightly rank check stores the top results; give it one run.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {["#", "App", "Subtitle", "Ratings", "Avg", "Title match"].map((h) => (
                        <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {serp.map((r) => (
                      <tr key={r.position} className="border-b border-[var(--border)]">
                        <td className="num px-3 py-2">{r.position}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {r.icon_url && <img src={r.icon_url} alt="" width={24} height={24} className="rounded-[6px]" />}
                            <span className="font-medium">{r.name ?? fmt.EM_DASH}</span>
                          </span>
                        </td>
                        <td className="max-w-xs truncate px-3 py-2 text-[var(--fg-muted)]">{r.subtitle ?? fmt.EM_DASH}</td>
                        <td className="num px-3 py-2">{r.rating_count == null ? fmt.EM_DASH : fmt.count(r.rating_count)}</td>
                        <td className="num px-3 py-2">{r.rating_average ?? fmt.EM_DASH}</td>
                        <td className="px-3 py-2">{r.title_match == null ? fmt.EM_DASH : r.title_match ? <Chip tone="beatable">yes</Chip> : <Chip>no</Chip>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12px] text-[var(--fg-subtle)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
