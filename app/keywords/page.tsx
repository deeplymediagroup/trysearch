import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { KeywordsTable } from "@/components/KeywordsTable";
import { DiscoveredTable } from "@/components/DiscoveredTable";
import { EmptyState, StalenessNote, Panel, Chip } from "@/components/ui";
import { AiButton } from "@/components/AiButton";
import { listKeywords, listDiscovered, getCountries, getStaleness, getPlaySearchTerms } from "@/lib/queries";
import { trackTermsFromAnalysis } from "@/app/actions/keywords";
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

  const [rows, discovered, countries, staleness, playTerms] = await Promise.all([
    listKeywords(active.tracked_app_id, active.app_id),
    listDiscovered(active.tracked_app_id, active.app_id),
    getCountries(active.tracked_app_id),
    getStaleness(active.app_id),
    active.platform === "android" ? getPlaySearchTerms(active.store_id) : Promise.resolve([]),
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

      {/*
        No <Suspense> here, deliberately. These tables call useSearchParams() (via useFilters),
        and wrapping that in a Suspense boundary opts the whole subtree OUT of server rendering:
        the server streams the fallback, the real markup arrives in a hidden div, and it only
        appears if the client finishes hydrating that boundary. It didn't — the page sat on
        "Loading keywords…" forever in production. There is nothing async in here to wait for
        (rows/discovered/countries are all awaited above), so the boundary bought nothing and
        cost the entire page. /rankings and /reviews render the same tables without one.
      */}
      {playTerms.length > 0 && tab === "tracked" && (
        <div className="px-6 pt-4">
          <Panel
            title="Real search terms (Play)"
            caption="MEASURED data from your Play Console — the actual queries that drove store visits, with conversion. Everything else on this page is modelled; these are ground truth. 'Other' is Google's low-volume rollup."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    {["Search term", "Visitors (60d)", "Installs (60d)", "CVR", ""].map((h, i) => (
                      <th key={i} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {playTerms.map((t) => (
                    <tr key={t.search_term} className="border-b border-[var(--border)]">
                      <td className="num px-3 py-1.5">
                        {t.search_term} <Chip tone="beatable">measured</Chip>
                      </td>
                      <td className="num px-3 py-1.5">{t.visitors ?? "—"}</td>
                      <td className="num px-3 py-1.5">{t.acquisitions ?? "—"}</td>
                      <td className="num px-3 py-1.5">{t.cvr != null ? `${t.cvr}%` : "—"}</td>
                      <td className="px-3 py-1.5 text-right">
                        {t.search_term.toLowerCase() === "other" ? null : t.tracked ? (
                          <Chip tone="branded">Tracked</Chip>
                        ) : (
                          <AiButton label="Track" pendingLabel="Tracking…" action={trackTermsFromAnalysis.bind(null, active.tracked_app_id, [t.search_term])} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

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
    </AppShell>
  );
}
