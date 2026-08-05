import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { RevenueLookup } from "@/components/RevenueLookup";
import { getRevenueEstimates } from "@/lib/queries";
import { currentWorkspace } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Revenue — trysearch" };
export const dynamic = "force-dynamic";

const CONFIDENCE_TONE: Record<string, "beatable" | "warn" | "neutral"> = {
  high: "beatable",
  medium: "warn",
  low: "neutral",
};

export default async function RevenuePage() {
  const { active } = await getActiveApp();
  const ws = await currentWorkspace();
  const rows: any[] = ws ? await getRevenueEstimates(ws.id) : [];
  const withEstimates = rows.filter((r) => r.display);

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

        <Panel
          title="Tracked apps"
          caption="Computed nightly by the crawler from real scraped in-app prices, install counts and rating volume."
        >
          {withEstimates.length === 0 ? (
            <EmptyState title="No estimates computed yet">
              Run <code className="num">npm run crawl -- --jobs app_snapshot,revenue</code>. It reuses the store page
              the snapshot job already fetched, so it costs no extra requests.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    {/* Four columns like the reference — range, IAP count and date fold in as subtext. */}
                    {["App", "Model", "Confidence"].map((h) => (
                      <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                    ))}
                    <th scope="col" className="th px-3 py-2 text-right whitespace-nowrap">Est. Revenue/mo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.platform}-${r.store_id}`} className="border-b border-[var(--border)]">
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          {r.role === "own" && <Chip tone="branded">Your app</Chip>}
                        </span>
                        <span className="block text-[11px] text-[var(--fg-subtle)]">{r.platform === "ios" ? "iOS" : "Android"}</span>
                      </td>
                      <td className="px-3 py-2.5 capitalize">
                        {r.model ? String(r.model).replace("_", " ") : fmt.EM_DASH}
                        <span className="block text-[11px] normal-case text-[var(--fg-subtle)]">
                          {r.iap_count > 0 ? `${r.iap_count} in-app prices` : "no in-app prices"}
                          {r.estimated_on ? ` · as of ${fmt.shortDate(r.estimated_on)}` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {r.confidence ? (
                          /* The factors ARE the confidence explanation, so they hang off the badge. */
                          <span className="group/conf relative inline-flex">
                            <Chip tone={CONFIDENCE_TONE[r.confidence] ?? "neutral"}>{r.confidence}</Chip>
                            {Array.isArray(r.factors) && r.factors.length > 0 && (
                              <span
                                role="tooltip"
                                className="pointer-events-none invisible absolute left-0 top-full z-50 mt-1 w-80 rounded-[var(--radius-chip)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5 text-left opacity-0 shadow-lg transition-opacity group-hover/conf:visible group-hover/conf:opacity-100"
                              >
                                <span className="th mb-1 block">How this was derived</span>
                                {(r.factors as string[]).map((f) => (
                                  <span key={f} className="mb-1 block text-[11px] leading-relaxed text-[var(--fg-muted)]">
                                    · {f}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        ) : (
                          fmt.EM_DASH
                        )}
                      </td>
                      <td className="num px-3 py-2.5 text-right font-medium">
                        {r.display ?? fmt.EM_DASH}
                        {r.monthly_usd_low != null && r.monthly_usd_high != null && (
                          <span className="block text-[11px] font-normal text-[var(--fg-subtle)]">
                            ${Number(r.monthly_usd_low).toLocaleString()} – ${Number(r.monthly_usd_high).toLocaleString()}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Look up any app's revenue"
          caption="Search any app on the App Store or Google Play to see its estimated monthly revenue — no tracking required. The result is cached, so asking twice is free."
        >
          <RevenueLookup />
        </Panel>

        <Panel title="About revenue estimates">
          <p className="text-[12px] leading-relaxed text-[var(--fg-muted)]">
            Estimates derive from public data such as install counts, review volumes, pricing, chart-rank signals,
            category benchmarks and industry averages. Actual revenue may differ significantly.{" "}
            <strong className="text-[var(--fg)]">Estimates below $5K/mo are not shown</strong> — they are rendered as
            <span className="num"> &lt;$5K/mo</span>, because precision we do not have would be a lie. iOS figures are
            inherently lower-confidence than Android, since Apple hides install counts entirely while Google Play
            publishes an exact number.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-muted)]">
            <strong className="text-[var(--fg)]">These are for sizing up competitors, not for reading your own
            numbers.</strong> For your own app the estimate is the weakest thing on this page: iOS installs are modelled
            from rating counts, which understates a subscription app badly. Connect App Store Connect and{" "}
            <a href="/performance" className="text-[var(--accent)] underline">Performance</a> will show your real
            proceeds instead of a model.
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
