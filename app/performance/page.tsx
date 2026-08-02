/**
 * /performance — 01-PRODUCT-SPEC.md §13. First-party App Store Connect downloads.
 * Reads asc_daily_metrics; until ASC credentials are connected the table is empty and the
 * page is an honest connect-prompt, not zeros.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, KpiTile, EmptyState } from "@/components/ui";
import { q } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Performance — trysearch" };
export const dynamic = "force-dynamic";

export default async function PerformancePage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/performance">
        <PageHeader title="Performance" />
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
  const byCountry = await q<any>(
    `select country, sum(downloads_first_time) as downloads, sum(proceeds_usd) as proceeds
       from asc_daily_metrics
      where app_id = $1 and country <> 'ALL' and metric_on >= current_date - 30
      group by country order by downloads desc nulls last limit 15`,
    [active.app_id],
  );

  const sum = (key: string) => (rows.length ? rows.reduce((s, r) => s + Number(r[key] ?? 0), 0) : null);

  return (
    <AppShell current="/performance">
      <PageHeader app={active} title="Performance" subtitle="App Store Connect · last 30 days" />

      <div className="space-y-4 p-6">
        {rows.length === 0 ? (
          <EmptyState title="Connect App Store Connect">
            This page shows YOUR real downloads and proceeds — first-party data, not estimates. It needs an App Store
            Connect API key (Users and Access → Integrations → App Store Connect API). Once the key is added the
            nightly <code className="num">asc_sync</code> job fills this in; nothing renders as zero in the meantime
            because unmeasured is not zero.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiTile label="Downloads" value={fmt.count(sum("downloads_first_time"))} subLabel="First-time, last 30 days" />
              <KpiTile label="Re-downloads" value={fmt.count(sum("downloads_redownload"))} subLabel="Returning installs" />
              <KpiTile label="In-app purchases" value={fmt.count(sum("iap_units"))} subLabel="Units sold" />
              <KpiTile label="Proceeds" value={sum("proceeds_usd") == null ? null : `≈ $${Math.round(sum("proceeds_usd")!).toLocaleString()}`} subLabel="Approximate — static FX rates" />
            </div>

            <Panel title="Daily downloads" caption="First-time downloads per day.">
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.metric_on} className="flex items-center gap-2 text-[11.5px]">
                    <span className="num w-20 shrink-0 text-[var(--fg-subtle)]">{fmt.isoDate(r.metric_on)}</span>
                    <span className="h-2 rounded-sm bg-[var(--accent)]" style={{ width: `${Math.min(100, (Number(r.downloads_first_time ?? 0) / Math.max(...rows.map((x) => Number(x.downloads_first_time ?? 0)), 1)) * 100)}%` }} />
                    <span className="num">{fmt.count(r.downloads_first_time)}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Top countries" caption="Downloads and approximate proceeds by storefront, last 30 days.">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    {["Country", "Downloads", "Proceeds"].map((h) => (
                      <th key={h} scope="col" className="th px-3 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {byCountry.map((c) => (
                    <tr key={c.country} className="border-b border-[var(--border)]">
                      <td className="num px-3 py-2 uppercase">{c.country}</td>
                      <td className="num px-3 py-2">{fmt.count(Number(c.downloads))}</td>
                      <td className="num px-3 py-2">{c.proceeds == null ? fmt.EM_DASH : `≈ $${Math.round(Number(c.proceeds)).toLocaleString()}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </div>
    </AppShell>
  );
}
