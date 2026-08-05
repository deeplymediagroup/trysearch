import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { RevenueLookup } from "@/components/RevenueLookup";
import { getRevenueEstimates } from "@/lib/queries";
import { currentWorkspace } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Revenue — trysearch" };
export const dynamic = "force-dynamic";

/** How the number was derived — the most important column on this page. */
const METHOD_LABELS: Record<string, string> = {
  measured: "Measured proceeds",
  grossing_rank: "Top-grossing rank",
  rank_only: "Rank only (uncalibrated)",
  rpi_benchmark: "Installs x RevenueCat RPI",
  installs_arpu: "Installs x ARPU (weak)",
  none: "No signal",
};

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
          caption="Best signal first: real proceeds if we have them, otherwise the app's top-grossing chart rank calibrated against a measured app on the same chart. Hover Confidence for the derivation."
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
                    {["App", "Method", "Model", "Confidence"].map((h) => (
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
                      <td className="px-3 py-2.5">
                        {r.method ? METHOD_LABELS[r.method] ?? r.method : fmt.EM_DASH}
                        {r.grossing_rank != null && (
                          <span className="num block text-[11px] text-[var(--fg-subtle)]">#{r.grossing_rank} grossing (US)</span>
                        )}
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

        <Panel title="How revenue is calculated">
          <p className="text-[12px] leading-relaxed text-[var(--fg-muted)]">
            Four signals, strongest first. <strong className="text-[var(--fg)]">Measured proceeds</strong> — real
            App Store Connect money, not an estimate.{" "}
            <strong className="text-[var(--fg)]">Top-grossing rank</strong> — Apple publishes a daily top-grossing
            chart per category and storefront, and grossing rank is the only public number that orders apps by money.
            Chart revenue decays as a power law in rank, so one calibrated app on a chart prices the whole chart:{" "}
            <span className="num">monthly = anchor x (anchorRank / rank) ^ 0.85</span>.{" "}
            <strong className="text-[var(--fg)]">Rank only</strong> — on a grossing chart with nothing to calibrate
            against, so the rank is shown and the dollars are withheld. An uncalibrated power law is a random number
            with a plausible shape.{" "}
            <strong className="text-[var(--fg)]">Installs x RevenueCat RPI</strong> — off-chart apps only: installs
            from measured rating velocity (new ratings a month across our own snapshots, not a lifetime average) times
            RevenueCat&apos;s published median revenue per install at day 60 from their State of Subscription Apps 2026
            report — $0.66 for Health &amp; Fitness, $0.34 across all categories, measured over 115,000+ apps. Widest
            band, permanently low confidence, because the install count under it is modelled.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-muted)]">
            To turn ranks into dollars, give the model one anchor: connect App Store Connect for an own app that sits
            on a grossing chart, or set <span className="num">REVENUE_ANCHOR_USD_MONTH</span> to that app&apos;s real
            monthly proceeds. Cross-check any figure here for free against{" "}
            <a href="https://rev.now" target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">rev.now</a>,{" "}
            <a href="https://featurepul.se/tools/app-store-revenue-downloads" target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">Featurepulse</a>{" "}
            or AppTweak&apos;s free Market Intelligence Starter plan — all three publish estimates without a paid seat.{" "}
            <strong className="text-[var(--fg)]">Estimates below $5K/mo are shown as{" "}
            <span className="num">&lt;$5K/mo</span></strong> — precision we do not have would be a lie.
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
