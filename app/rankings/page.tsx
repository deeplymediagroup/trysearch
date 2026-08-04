import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { RankingsView } from "@/components/RankingsView";
import { EmptyState, StalenessNote } from "@/components/ui";
import { listKeywords, getRankHistory, getAnnotations, getCountries, getStaleness } from "@/lib/queries";

export const metadata = { title: "Rankings — trysearch" };
export const dynamic = "force-dynamic";

export default async function RankingsPage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/rankings">
        <PageHeader title="Rankings" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const [rows, countries, staleness, annotations] = await Promise.all([
    listKeywords(active.tracked_app_id, active.app_id),
    getCountries(active.tracked_app_id),
    getStaleness(active.app_id),
    getAnnotations(active.tracked_app_id, 90),
  ]);

  // 365 days so every range in the chart's picker has data behind it; the payload stays
  // small (one row per keyword-day) and the client filters down from here.
  const history = await getRankHistory(active.app_id, rows.map((r) => r.keyword_id), 365);

  return (
    <AppShell current="/rankings">
      <PageHeader
        app={active}
        title="Rankings"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{active.device ?? "iphone"} · {rows.filter((r) => r.rank != null).length} keywords ranking</span>
            <StalenessNote date={staleness} />
          </span>
        }
      />
      <RankingsView rows={rows} countries={countries} history={history as any} annotations={annotations as any} />
    </AppShell>
  );
}
