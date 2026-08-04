/**
 * /dashboard — the app snapshot (01-PRODUCT-SPEC.md §1).
 *
 * A Server Component reading Postgres directly. Its numbers come from app_daily_metrics and
 * ranking_current, never from aggregating raw rankings at request time.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { KpiTile, KpiStrip, Panel, RankPill, DeltaBadge, Sparkline, CountryFlag, EmptyState, StalenessNote, EstimateLegend, Chip } from "@/components/ui";
import { VisibilityChart, ShareOfVoiceChart, RankDistributionPanel } from "@/components/Charts";
import { AchievementsGrid } from "@/components/Achievements";
import { getActiveAppData } from "./data";
import * as fmt from "@/lib/format";

export const metadata = { title: "Dashboard — trysearch" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { active } = await getActiveApp();

  if (!active) {
    return (
      <AppShell current="/dashboard">
        <PageHeader title="Dashboard" />
        <div className="p-6">
          <EmptyState title="No app tracked yet">
            Track your first app with{" "}
            <code className="num">node scripts/seed-app.mjs --ios 1487761500 --countries us,gb --keywords &quot;motivation,discipline&quot;</code>
            , then run <code className="num">npm run crawl -- --all</code>.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const d = await getActiveAppData(active);

  return (
    <AppShell current="/dashboard">
      <PageHeader
        app={active}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{d.keywordCount} keywords</span>
            <StalenessNote date={d.staleness} />
          </span>
        }
        actions={
          <span className="flex items-center gap-3 text-[13px] text-[var(--fg-subtle)]">
            <span><span className="text-[var(--warn)]">★</span> {fmt.rating(active.rating_average)} <span className="text-[var(--fg-subtle)]">{fmt.count(active.rating_count)} ratings</span></span>
            {active.version && <span className="num">v{active.version}</span>}
          </span>
        }
      />

      <div className="space-y-4 p-6">
        {/* KPI strip — one connected segmented row */}
        <KpiStrip>
          <KpiTile label="Visibility" value={d.latest?.visibility == null ? null : fmt.score(Number(d.latest.visibility))} delta={d.visibilityDelta} subLabel="Popularity-weighted reach" />
          <KpiTile
            label="Share of voice"
            value={d.latest?.share_of_voice == null ? null : fmt.percent(Number(d.latest.share_of_voice))}
            subLabel={`${d.brandedCount} branded excluded`}
          />
          <KpiTile label="Ranked" value={d.latest?.ranked_count ?? null} delta={d.rankedDelta} subLabel={`of ${d.keywordCount} tracked`} />
          <KpiTile label="Best rank" value={d.latest?.best_rank ? `#${d.latest.best_rank}` : null} subLabel={(d.latest as any)?.best_rank_term ?? undefined} />
          <KpiTile label="Top 10" value={d.latest?.top10_count ?? null} subLabel="keywords ranked ≤10" />
          <KpiTile label="Movers (7d)" value={`↑${d.latest?.movers_up ?? 0} ↓${d.latest?.movers_down ?? 0}`} subLabel="up / down" />
        </KpiStrip>

        <EstimateLegend extra="Visibility and share of voice are computed from tracked keywords only." />

        {/* Charts */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Visibility" caption="From your tracked keywords' ranks, weighted by popularity.">
            <VisibilityChart data={d.series as any} />
          </Panel>
          <Panel title="Share of voice" caption="Branded keywords excluded, so this is generic demand only.">
            <ShareOfVoiceChart data={d.series as any} />
          </Panel>
        </div>

        <Panel title="Ranked Keywords" caption="Stacked by rank bracket. Unranked keywords are excluded, not placed in 100+.">
          <RankDistributionPanel data={d.distribution} />
        </Panel>

        <Panel title="Achievements" caption="Derived live from your rank data. Click an unlocked feat to download a share card.">
          <AchievementsGrid keywords={d.featInputs} appName={active.name} />
        </Panel>

        {/* Panels */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel
            title="Keywords"
            caption="Your first six tracked keywords."
            action={<Link href="/rankings" className="text-[11px] text-[var(--accent)]">View all →</Link>}
          >
            <ul className="divide-y divide-[var(--border)]">
              {d.topKeywords.map((k) => (
                <li key={`${k.keyword_id}-${k.country}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <CountryFlag country={k.country} showCode={false} />
                    <span className="num truncate text-[12px]">{k.term}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Sparkline ranks={(k.trend ?? []) as (number | null)[]} />
                    <RankPill state={{ rank: k.rank, found: k.found ?? false, last_known_rank: k.last_known_rank, crawl_depth: k.crawl_depth, checked: k.checked_at != null }} />
                    <DeltaBadge value={k.delta_7d} />
                  </span>
                </li>
              ))}
              {!d.topKeywords.length && <li className="py-3 text-[12px] text-[var(--fg-subtle)]">No keywords tracked yet.</li>}
            </ul>
          </Panel>

          <Panel title="Opportunities" caption="Where to push next, with the reason in plain English.">
            <ul className="divide-y divide-[var(--border)]">
              {d.opportunities.map((o) => (
                <li key={`${o.keyword_id}-${o.country}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="num block truncate text-[12px]">{o.term}</span>
                    <span className="text-[11px] text-[var(--fg-subtle)]">{o.reason}</span>
                  </span>
                  <RankPill state={{ rank: o.rank, found: o.found ?? false, last_known_rank: o.last_known_rank, checked: true }} />
                </li>
              ))}
              {!d.opportunities.length && <li className="py-3 text-[12px] text-[var(--fg-subtle)]">Nothing within reach yet — run the crawler to build history.</li>}
            </ul>
            <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-2 text-[11px]">
              <Link href="/keywords?tab=discovered" className="block text-[var(--accent)]">
                {d.discoveredCount} new keyword discoveries to review
              </Link>
              <Link href="/competitors" className="block text-[var(--accent)]">
                {d.buckets.winnable} winnable keyword gaps vs your competitors
              </Link>
              {d.biggestGap && (
                <p className="text-[var(--fg-muted)]">
                  Biggest: <span className="num">&quot;{d.biggestGap.term}&quot;</span> — {d.biggestGap.competitor_name} ranks #{d.biggestGap.their_rank}, you&apos;re unranked
                </p>
              )}
              <Link href="/competitors" className="block text-[var(--accent)]">{d.buckets.threat} threats →</Link>
            </div>
          </Panel>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Panel title="Top Improvements (7d)" caption="Positive means the rank got better.">
            <MoverList rows={d.improvements} />
          </Panel>
          <Panel title="Biggest Drops (7d)" caption="Negative means the rank got worse.">
            <MoverList rows={d.drops} />
          </Panel>
          <Panel title="Coverage" caption="What the crawler has collected so far.">
            <dl className="space-y-1.5 text-[12px]">
              <Row label="Keywords" value={fmt.count(d.keywordCount)} />
              <Row label="Rankings" value={`${fmt.count(d.latest?.ranked_count ?? 0)} ranked`} />
              <Row label="Competitors" value={fmt.count(d.competitorCount)} />
              <Row label="Discoveries" value={fmt.count(d.discoveredCount)} />
              <Row label="Reviews" value={fmt.count(d.reviewCount)} />
            </dl>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function MoverList({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="py-3 text-[12px] text-[var(--fg-subtle)]">No movement measured yet — this needs two days of crawl history.</p>;
  return (
    <ul className="divide-y divide-[var(--border)]">
      {rows.map((r) => (
        <li key={`${r.keyword_id}-${r.country}`} className="flex items-center justify-between gap-2 py-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <CountryFlag country={r.country} showCode={false} />
            <span className="num truncate text-[12px]">{r.term}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <RankPill state={{ rank: r.rank, found: r.found ?? false, checked: true }} />
            <DeltaBadge value={r.delta_7d} />
          </span>
        </li>
      ))}
    </ul>
  );
}
