/**
 * /top-charts — daily top-100 snapshots with day-over-day movement (Workstream H).
 *
 * Reads chart_entries only; the crawler's `charts` job writes one snapshot per day for the
 * combos the team's apps live in. A "new" badge means no row yesterday — which is different
 * from a delta of zero, same missing-≠-zero rule as everywhere else.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState, Sparkline, DeltaBadge } from "@/components/ui";
import { getChartCombos, getChartSnapshot } from "@/lib/queries";
import { ExportButtons } from "@/components/ExportButtons";
import * as fmt from "@/lib/format";

export const metadata = { title: "Top Charts — trysearch" };
export const dynamic = "force-dynamic";

const CHART_LABELS: Record<string, string> = {
  topfreeapplications: "Top Free",
  topgrossingapplications: "Top Grossing",
  toppaidapplications: "Top Paid",
  default: "Top Apps",
};

export default async function TopChartsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { active } = await getActiveApp();
  const combos = await getChartCombos();

  if (!combos.length) {
    return (
      <AppShell current="/top-charts">
        <PageHeader app={active ?? undefined} title="Top Charts" />
        <div className="p-6">
          <EmptyState title="No chart snapshots yet">
            The crawler&apos;s <code className="num">charts</code> job takes a daily top-100 snapshot for the
            countries and categories your apps live in. Run it once (<code className="num">node scripts/crawl.mjs --jobs charts</code>)
            and this page fills in; movement needs two days of history.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const platform = sp.store ?? combos[0].platform;
  const country = sp.country ?? combos.find((c) => c.platform === platform)?.country ?? "us";
  const category = sp.category ?? combos.find((c) => c.platform === platform && c.country === country)?.category ?? "all";
  const chart = sp.chart ?? combos.find((c) => c.platform === platform && c.country === country && c.category === category)?.chart ?? "topfreeapplications";

  const { date, rows, dropped } = await getChartSnapshot(platform, country, category, chart);

  const withDelta = rows.map((r) => ({ ...r, delta: r.prev_rank == null ? null : r.prev_rank - r.rank }));
  const movers = [...withDelta].filter((r) => r.delta != null && r.delta !== 0).sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!)).slice(0, 6);

  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ store: platform, country, category, chart, ...patch });
    return `/top-charts?${params}`;
  };

  return (
    <AppShell current="/top-charts">
      <PageHeader
        app={active ?? undefined}
        title="Top Charts"
        subtitle={date ? `Snapshot ${date} · movement vs the previous day` : "No snapshot for this selection yet"}
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
        {[...new Set(combos.map((c) => c.platform))].map((p) => (
          <Link key={p} href={href({ store: p })} className={`rounded-[var(--radius-chip)] border px-2.5 py-1 text-[12px] ${p === platform ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}>
            {p === "ios" ? "App Store" : "Google Play"}
          </Link>
        ))}
        <span className="text-[var(--fg-subtle)]">·</span>
        {[...new Set(combos.filter((c) => c.platform === platform).map((c) => c.country))].map((c) => (
          <Link key={c} href={href({ country: c })} className={`rounded-[var(--radius-chip)] border px-2 py-1 text-[12px] ${c === country ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}>
            {c.toUpperCase()}
          </Link>
        ))}
        <span className="text-[var(--fg-subtle)]">·</span>
        {[...new Set(combos.filter((c) => c.platform === platform && c.country === country).map((c) => c.category))].map((cat) => (
          <Link key={cat} href={href({ category: cat })} className={`rounded-[var(--radius-chip)] border px-2 py-1 text-[12px] ${cat === category ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}>
            {cat === "all" ? "All apps" : cat}
          </Link>
        ))}
        {platform === "ios" && (
          <>
            <span className="text-[var(--fg-subtle)]">·</span>
            {[...new Set(combos.filter((c) => c.platform === platform && c.country === country && c.category === category).map((c) => c.chart))].map((ch) => (
              <Link key={ch} href={href({ chart: ch })} className={`rounded-[var(--radius-chip)] border px-2 py-1 text-[12px] ${ch === chart ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}>
                {CHART_LABELS[ch] ?? ch}
              </Link>
            ))}
          </>
        )}
      </div>

      <div className="grid gap-4 p-6 lg:grid-cols-[1fr_280px]">
        <Panel
          caption="Click a row for its 30-day rank history. Your tracked apps are highlighted."
          action={<ExportButtons name={`top-charts-${platform}-${country}-${category}`} rows={withDelta.map((r) => ({ rank: r.rank, delta: r.delta, app: r.name, developer: r.developer_name, store_id: r.store_id }))} />}
        >
          {rows.length === 0 ? (
            <EmptyState title="No snapshot for this selection yet">Give the nightly crawl one run.</EmptyState>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["#", "Δ", "App", "Developer", "30 days"].map((h) => (
                    <th key={h} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {withDelta.map((r) => (
                  <tr key={r.rank} className={`border-b border-[var(--border)] ${r.tracked ? "bg-[var(--accent-soft)]" : ""}`}>
                    <td className="num px-3 py-1.5">{r.rank}</td>
                    <td className="px-3 py-1.5">{r.delta == null ? <Chip tone="neutral">new</Chip> : <DeltaBadge value={r.delta} />}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        {r.icon_url && <img src={r.icon_url} alt="" width={20} height={20} className="rounded-[5px]" />}
                        <span className="num">{r.name}</span>
                        {r.tracked && <Chip tone="branded">Tracked</Chip>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--fg-muted)]">{r.developer_name ?? fmt.EM_DASH}</td>
                    <td className="px-3 py-1.5"><Sparkline ranks={r.trend} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Biggest movers" caption="Largest absolute day-over-day change.">
            {movers.length === 0 ? (
              <p className="text-[12px] text-[var(--fg-muted)]">Movement needs two consecutive snapshots.</p>
            ) : (
              <ul className="space-y-1.5">
                {movers.map((m) => (
                  <li key={m.rank} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="num min-w-0 truncate">#{m.rank} {m.name}</span>
                    <DeltaBadge value={m.delta} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Dropped out" caption="In yesterday's snapshot, gone today.">
            {dropped.length === 0 ? (
              <p className="text-[12px] text-[var(--fg-muted)]">Nobody fell off.</p>
            ) : (
              <ul className="space-y-1.5">
                {dropped.map((d) => (
                  <li key={d.name} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="num min-w-0 truncate">{d.name}</span>
                    <span className="num text-[11px] text-[var(--fg-subtle)]">was #{d.prev_rank}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
