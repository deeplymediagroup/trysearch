import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { getCompetitors } from "@/lib/queries";
import * as fmt from "@/lib/format";

export const metadata = { title: "Revenue — trysearch" };
export const dynamic = "force-dynamic";

export default async function RevenuePage() {
  const { active } = await getActiveApp();
  const competitors = active ? await getCompetitors(active.tracked_app_id) : [];

  return (
    <AppShell current="/revenue">
      <PageHeader app={active} title="Revenue" subtitle="Estimates from public data only." />
      <div className="space-y-4 p-6">
        <div className="rounded-[var(--radius)] border border-[var(--warn)] bg-[rgba(245,158,11,0.08)] p-3">
          <p className="text-[12px] text-[var(--warn)]">
            <Chip tone="warn">ALPHA</Chip> Revenue estimates are an early feature. Accuracy will improve as we add more
            data signals.
          </p>
        </div>

        <Panel title="Estimates" caption="Computed by the crawler from scraped in-app prices, install counts and rating volume.">
          {competitors.every((c: any) => !c.revenue_display) ? (
            <EmptyState title="No estimates computed yet">
              Revenue needs the in-app price scraper to run against each app. It is off by default because it costs one
              store-page fetch per app per day.
            </EmptyState>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["App", "Model", "Confidence", "Est. Revenue/mo"].map((h) => (
                    <th key={h} scope="col" className="th px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {competitors.map((c: any) => (
                  <tr key={c.app_id} className="border-b border-[var(--border)]">
                    <td className="num px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 capitalize">{c.revenue_model ?? fmt.EM_DASH}</td>
                    <td className="px-3 py-2 capitalize">{c.revenue_confidence ?? fmt.EM_DASH}</td>
                    <td className="num px-3 py-2">{c.revenue_display ?? fmt.EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="About revenue estimates">
          <p className="text-[12px] leading-relaxed text-[var(--fg-muted)]">
            Estimates derive from public data such as install counts, review volumes, pricing, chart-rank signals,
            category benchmarks and industry averages. Actual revenue may differ significantly.{" "}
            <strong className="text-[var(--fg)]">Estimates below $5K/mo are not shown</strong> — they are rendered as
            <span className="num"> &lt;$5K/mo</span>, because precision we do not have would be a lie. iOS figures are
            inherently lower-confidence than Android, since Apple hides install counts entirely while Google Play
            publishes an exact number. These figures are for competitive benchmarking, not financial reporting.
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
