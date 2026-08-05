/**
 * /performance — 01-PRODUCT-SPEC.md §13. First-party App Store Connect downloads.
 * Reads asc_daily_metrics; until ASC credentials are connected the table is empty and the
 * page is an honest connect-prompt, not zeros.
 *
 * Layout mirrors the reference: KPI cards → Daily downloads chart → Daily proceeds chart →
 * Top countries table.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, EmptyState, CountryFlag } from "@/components/ui";
import { StatCard } from "@/components/StatCard";
import { TrendAreaChart } from "@/components/TrendAreaChart";
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

  // Missing ≠ zero: a row can exist for its impressions (from Analytics) while carrying no
  // downloads/proceeds at all (from Sales Reports, which need a vendor number Analytics
  // doesn't). Sum only when at least one row actually measured the column — otherwise the
  // "0" would be a lie, not a measurement.
  const sum = (key: string) => {
    const measured = rows.filter((r) => r[key] != null);
    return measured.length ? measured.reduce((s, r) => s + Number(r[key]), 0) : null;
  };
  const hasDownloads = rows.some((r) => r.downloads_first_time != null);

  return (
    <AppShell current="/performance">
      <PageHeader app={active} title={active.name} subtitle="App Store Connect · last 30 days" />

      <div className="space-y-4 p-6">
        {!hasDownloads ? (
          <EmptyState title="Downloads and proceeds need a vendor number">
            Engagement data (impressions, page views) comes from App Store Connect Analytics, which is already
            connected. Downloads and proceeds come from a separate report — Sales Reports — which needs{" "}
            <code className="num">ASC_VENDOR_NUMBER</code> (Payments and Financial Reports in App Store Connect, not
            the Analytics key). Nothing renders as zero in the meantime because unmeasured is not zero.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Downloads" value={fmt.count(sum("downloads_first_time"))} sub="First-time, last 30 days" />
              <StatCard label="Re-downloads" value={fmt.count(sum("downloads_redownload"))} sub="Returning installs" />
              <StatCard label="In-app purchases" value={fmt.count(sum("iap_units"))} sub="Units sold" />
              <StatCard
                label="Proceeds"
                value={sum("proceeds_usd") == null ? null : `≈ $${Math.round(sum("proceeds_usd")!).toLocaleString()}`}
                sub="Approximate — static FX rates"
              />
            </div>

            <Panel title="Daily downloads">
              <TrendAreaChart
                data={rows}
                series={[{ key: "downloads_first_time", label: "Downloads", colour: "var(--chart)" }]}
              />
            </Panel>

            <Panel title="Daily proceeds (approx. USD)">
              <TrendAreaChart
                data={rows}
                series={[{ key: "proceeds_usd", label: "Proceeds", colour: "var(--up)" }]}
                tickPrefix="$"
              />
            </Panel>

            <Panel title="Top countries">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th scope="col" className="th px-3 py-2 text-left">Country</th>
                    <th scope="col" className="th px-3 py-2 text-right">Downloads</th>
                    <th scope="col" className="th px-3 py-2 text-right">Proceeds</th>
                  </tr>
                </thead>
                <tbody>
                  {byCountry.map((c) => (
                    <tr key={c.country} className="border-b border-[var(--border)]">
                      <td className="px-3 py-2"><CountryFlag country={c.country} /></td>
                      <td className="num px-3 py-2 text-right">{fmt.count(c.downloads == null ? null : Number(c.downloads))}</td>
                      <td className="num px-3 py-2 text-right">{c.proceeds == null ? fmt.EM_DASH : `≈ $${Math.round(Number(c.proceeds)).toLocaleString()}`}</td>
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
