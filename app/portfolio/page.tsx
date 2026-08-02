import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { KpiTile, Panel, EmptyState, DeltaBadge } from "@/components/ui";
import { listTrackedApps, getLatestMetrics, getVisibility7dAgo } from "@/lib/queries";
import { AddAppDialog } from "@/components/AddDialog";
import { UntrackAppButton } from "@/components/UntrackButtons";
import * as fmt from "@/lib/format";

export const metadata = { title: "Portfolio — trysearch" };
export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const { active } = await getActiveApp();
  const apps = (await listTrackedApps()).filter((a) => a.role === "own");
  const metrics = await Promise.all(
    apps.map(async (a) => {
      const [m, was] = await Promise.all([getLatestMetrics(a.app_id) as Promise<any>, getVisibility7dAgo(a.app_id)]);
      const now = m?.visibility == null ? null : Number(m.visibility);
      // Higher visibility is better, so now-minus-then is already the "positive = improved"
      // sign DeltaBadge expects. Either side missing → null → em dash.
      return { app: a, m, delta7d: now == null || was == null ? null : Math.round((now - was) * 10) / 10 };
    }),
  );

  return (
    <AppShell current="/portfolio">
      <PageHeader
        app={active}
        title="Portfolio"
        subtitle="Every app you track, rolled up into one view."
        actions={<AddAppDialog />}
      />
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile label="Apps" value={apps.length} />
          <KpiTile
            label="Visibility"
            value={metrics.length ? fmt.score(avg(metrics.map((x) => Number(x.m?.visibility)).filter(Number.isFinite))) : null}
            subLabel="mean across apps"
          />
          <KpiTile label="Top 10 rankings" value={sum(metrics.map((x) => x.m?.top10_count ?? 0))} />
          <KpiTile
            label="Movement (7d)"
            value={`↑${sum(metrics.map((x) => x.m?.movers_up ?? 0))} ↓${sum(metrics.map((x) => x.m?.movers_down ?? 0))}`}
          />
        </div>

        <Panel title="Apps" caption="One row per tracked app. Δ 7d compares visibility to a week ago.">
          {apps.length === 0 ? (
            <EmptyState title="No apps tracked yet" action={<AddAppDialog />}>
              Paste a store link, an id, or the app&apos;s name.
            </EmptyState>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["App", "Visibility", "Δ 7d", "Top 10", "Rating", ""].map((h) => (
                    <th key={h} scope="col" className="th px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map(({ app, m, delta7d }) => (
                  <tr key={app.app_id} className="border-b border-[var(--border)]">
                    <td className="num px-3 py-2">{app.name}</td>
                    <td className="num px-3 py-2">{m?.visibility == null ? fmt.EM_DASH : fmt.score(Number(m.visibility))}</td>
                    <td className="px-3 py-2"><DeltaBadge value={delta7d} /></td>
                    <td className="num px-3 py-2">{m?.top10_count ?? fmt.EM_DASH}</td>
                    <td className="num px-3 py-2">★ {fmt.rating(app.rating_average)}</td>
                    <td className="px-3 py-2 text-right">
                      <UntrackAppButton trackedAppId={app.tracked_app_id} name={app.name} keywordCount={app.keyword_count} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <p className="text-[11px] leading-relaxed text-[var(--fg-subtle)]">
          Visibility sums search popularity weighted by rank position across an app&apos;s tracked keywords — higher is
          better. Δ 7d and movement compare each keyword&apos;s latest rank to ~7 days ago. Open Rankings for
          per-keyword history.
        </p>
      </div>
    </AppShell>
  );
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const avg = (ns: number[]) => (ns.length ? sum(ns) / ns.length : null);
