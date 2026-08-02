/**
 * /engagement — 01-PRODUCT-SPEC.md §14. The App Store funnel: impressions → product page
 * views → downloads, plus where impressions come from. Same data source and empty-state
 * rules as /performance.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, KpiTile, EmptyState } from "@/components/ui";
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
      <PageHeader app={active} title="Engagement" subtitle="App Store engagement · last 30 days" />

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
              <KpiTile label="Impressions" value={fmt.count(impressions)} subLabel="Store placements seen" />
              <KpiTile label="Product page views" value={fmt.count(pageViews)} subLabel={`${pct(pageViews, impressions) ?? "—"}of impressions`} />
              <KpiTile label="Downloads" value={fmt.count(downloads)} subLabel={`${pct(downloads, pageViews) ?? "—"}of page views`} />
              <KpiTile label="From search" value={pct(sum("impressions_search"), impressions) ?? fmt.EM_DASH} subLabel="Share of impressions" />
            </div>

            <Panel title="Where impressions come from" caption="The four App Store discovery surfaces, last 30 days.">
              <ul className="space-y-1.5">
                {sources.map(([label, n]) => (
                  <li key={label} className="flex items-center gap-2 text-[12px]">
                    <span className="w-36 shrink-0">{label}</span>
                    <span className="h-2 rounded-sm bg-[var(--accent)]" style={{ width: `${impressions ? Math.min(100, ((n ?? 0) / impressions) * 100) : 0}%` }} />
                    <span className="num">{fmt.count(n)}</span>
                    <span className="num text-[var(--fg-subtle)]">{pct(n, impressions) ?? fmt.EM_DASH}</span>
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
