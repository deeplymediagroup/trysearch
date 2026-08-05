/**
 * /engagement — 01-PRODUCT-SPEC.md §14. The App Store funnel: impressions → product page
 * views → downloads, plus where impressions come from. Same data source and empty-state
 * rules as /performance.
 *
 * Layout mirrors the reference: KPI cards → Impressions & page views chart → source bars.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, EmptyState } from "@/components/ui";
import { StatCard } from "@/components/StatCard";
import { TrendAreaChart } from "@/components/TrendAreaChart";
import { q } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Engagement — trysearch" };
export const dynamic = "force-dynamic";

export default async function EngagementPage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/engagement">
        <PageHeader title="Engagement" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const rows = await q<any>(
    `select * from asc_daily_metrics
      where app_id = $1 and country = 'ALL' and metric_on >= current_date - 30
      order by metric_on`,
    [active.app_id],
  );

  const sum = (key: string) => (rows.length ? rows.reduce((s, r) => s + Number(r[key] ?? 0), 0) : null);
  const impressions = sum("impressions");
  const pageViews = sum("product_page_views");
  const downloads = sum("downloads_first_time");
  const pct = (a: number | null, b: number | null) => (a == null || !b ? null : `${((a / b) * 100).toFixed(1)}% `);

  const sources = [
    ["App Store search", sum("impressions_search")],
    ["App Store browse", sum("impressions_browse")],
    ["App referrer", sum("impressions_app_referrer")],
    ["Web referrer", sum("impressions_web_referrer")],
  ] as const;

  return (
    <AppShell current="/engagement">
      <PageHeader app={active} title={active.name} subtitle="App Store engagement · last 30 days" />

      <div className="space-y-4 p-6">
        {rows.length === 0 ? (
          <EmptyState title="Connect App Store Connect">
            The impressions → page views → downloads funnel comes from App Store Connect Analytics — your own
            first-party data. Add an App Store Connect API key and the nightly{" "}
            <code className="num">asc_sync</code> job fills this in.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Impressions" value={fmt.count(impressions)} sub="App Store, last 30 days" />
              <StatCard label="Product page views" value={fmt.count(pageViews)} sub={`${pct(pageViews, impressions) ?? "—"}of impressions`} />
              <StatCard label="Downloads" value={fmt.count(downloads)} sub={`${pct(downloads, pageViews) ?? "—"}of page views`} />
              <StatCard label="From search" value={(pct(sum("impressions_search"), impressions) ?? fmt.EM_DASH).trim()} sub="Share of impressions" />
            </div>

            <Panel title="Impressions & page views">
              <TrendAreaChart
                data={rows}
                series={[
                  { key: "impressions", label: "Impressions", colour: "#8b5cf6" },
                  { key: "product_page_views", label: "Page views", colour: "var(--chart)" },
                ]}
              />
            </Panel>

            <Panel title="Where impressions come from" caption="The four App Store discovery surfaces, last 30 days.">
              <ul className="divide-y divide-[var(--border)]">
                {sources.map(([label, n]) => (
                  <li key={label} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold">{label}</span>
                      <span className="num text-[12px] text-[var(--fg-subtle)]">
                        {fmt.count(n)} · {(pct(n, impressions) ?? fmt.EM_DASH).trim()}
                      </span>
                    </div>
                    <div aria-hidden className="mt-2 h-1 w-full">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${impressions ? Math.max(0.5, Math.min(100, ((n ?? 0) / impressions) * 100)) : 0}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </div>
    </AppShell>
  );
}
