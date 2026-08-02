import { Suspense } from "react";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { KeywordsTable } from "@/components/KeywordsTable";
import { DiscoveredTable } from "@/components/DiscoveredTable";
import { EmptyState, StalenessNote } from "@/components/ui";
import { listKeywords, listDiscovered, getCountries, getStaleness } from "@/lib/queries";
import { AddAppDialog, AddKeywordsDialog } from "@/components/AddDialog";
import Link from "next/link";

export const metadata = { title: "Keywords — trysearch" };
export const dynamic = "force-dynamic"; // crawled data changes nightly; never serve a stale shell

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "tracked" } = await searchParams;
  const { active } = await getActiveApp();

  if (!active) {
    return (
      <AppShell current="/keywords">
        <PageHeader title="Keywords" />
        <div className="p-6">
          <EmptyState title="No app tracked yet" action={<AddAppDialog />}>
            Paste a store link, an App Store id, a package name, or the app&apos;s name.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const [rows, discovered, countries, staleness] = await Promise.all([
    listKeywords(active.tracked_app_id, active.app_id),
    listDiscovered(active.tracked_app_id, active.app_id),
    getCountries(active.tracked_app_id),
    getStaleness(active.app_id),
  ]);

  return (
    <AppShell current="/keywords">
      <PageHeader
        app={active}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{active.device ?? "iphone"} · {rows.length} tracked keywords</span>
            <StalenessNote date={staleness} />
          </span>
        }
        actions={
          <>
            <Link href="/keywords?tab=discovered" className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] leading-7 text-[var(--fg-muted)] hover:text-[var(--fg)]">
              Discover keywords
            </Link>
            <AddKeywordsDialog trackedAppId={active.tracked_app_id} countries={countries} />
          </>
        }
      />

      <nav className="flex gap-1 border-b border-[var(--border)] px-6" aria-label="Keyword tabs">
        {[
          { id: "tracked", label: "Tracked", n: rows.length },
          { id: "discovered", label: "Discovered", n: discovered.length },
        ].map((t) => (
          <Link
            key={t.id}
            href={`/keywords?tab=${t.id}`}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] ${tab === t.id ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
          >
            {t.label} <span className="num text-[var(--fg-subtle)]">{t.n}</span>
          </Link>
        ))}
      </nav>

      <Suspense fallback={<p className="p-6 text-[12px] text-[var(--fg-subtle)]">Loading keywords…</p>}>
        {tab === "discovered" ? (
          <DiscoveredTable
            rows={discovered as any}
            countries={countries}
            trackedAppId={active.tracked_app_id}
            autoTrackRanked={active.auto_track_ranked}
          />
        ) : (
          <KeywordsTable rows={rows} countries={countries} />
        )}
      </Suspense>
    </AppShell>
  );
}
