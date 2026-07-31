import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { KpiTile, Panel, EmptyState, RankPill, DeltaBadge } from "@/components/ui";
import { listTrackedApps, getLatestMetrics } from "@/lib/queries";
import * as fmt from "@/lib/format";

export const metadata = { title: "Portfolio — trysearch" };
export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const { active } = await getActiveApp();
  const apps = (await listTrackedApps()).filter((a) => a.role === "own");
  const metrics = await Promise.all(apps.map(async (a) => ({ app: a, m: (await getLatestMetrics(a.app_id)) as any })));

  return (
    <AppShell current="/portfolio">
      <PageHeader app={active} title="Portfolio" subtitle="Every app you track, rolled up into one view." />
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

        <Panel title="Apps" caption="One row per tracked app.">
          {apps.length <= 1 ? (
            <EmptyState title="Portfolio needs several apps">
              You track {apps.length} app. This view only becomes meaningful with a few — add another with{" "}
              <code className="num">seed-app.mjs</code>.
            </EmptyState>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["App", "Visibility", "Δ 7d", "Top 10", "Rating"].map((h) => (
                    <th key={h} scope="col" className="th px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map(({ app, m }) => (
                  <tr key={app.app_id} className="border-b border-[var(--border)]">
                    <td className="num px-3 py-2">{app.name}</td>
                    <td className="num px-3 py-2">{m?.visibility == null ? fmt.EM_DASH : fmt.score(Number(m.visibility))}</td>
                    <td className="px-3 py-2"><DeltaBadge value={null} /></td>
                    <td className="num px-3 py-2">{m?.top10_count ?? fmt.EM_DASH}</td>
                    <td className="num px-3 py-2">★ {fmt.rating(app.rating_average)}</td>
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
