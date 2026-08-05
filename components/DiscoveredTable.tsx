"use client";

/**
 * The Discovered tab — 01-PRODUCT-SPEC.md §2.3.
 *
 * Keywords the system found that the user has NOT yet chosen to track. Its sources differ
 * from the Tracked tab: AI, Your listing, Autocomplete, Competitor.
 */
import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, FilterBar, applyFilters, useFilters } from "./DataTable";
import { RankPill, ScoreCell, PopularityCell, CountryFlag, EmptyState, EstimateLegend, SourceChip } from "./ui";
import * as fmt from "@/lib/format";
import { promoteDiscovered, dismissDiscovered, setAutoTrackRanked } from "@/app/actions/keywords";
import { runDiscovery } from "@/app/actions/discovery";
import type { DiscoveredRow } from "@/lib/queries";

const SUB_TABS = [
  // Relevant is the default view: discovery casts a wide net (chart + competitor subtitle
  // bigrams), so unfiltered "All" is mostly terms nobody would ever search for this app.
  { id: "relevant", label: "Relevant" },
  { id: "all", label: "All" },
  { id: "ranked", label: "Ranked" },
  { id: "opportunities", label: "Opportunities" },
];

export type DiscoveryRun = { id: string; status: string; progress: string | null; found: number } | null;

/** "Re-run discovery" button + market picker; polls the server payload while a run is live. */
function RunDiscoveryControl({ trackedAppId, countries, run }: { trackedAppId: string; countries: string[]; run: DiscoveryRun }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(countries.slice(0, 1)));
  const [error, setError] = useState<string | null>(null);
  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [running, router]);

  if (running) {
    return (
      <span className="flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
        {run?.progress ?? "Running…"} <span className="num text-[var(--fg-subtle)]">{run?.found ?? 0} found</span>
      </span>
    );
  }

  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="h-8 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
        Re-run discovery{run?.status === "done" ? ` · last found ${run.found}` : ""}
      </button>
      {open && (
        <span className="absolute right-0 top-full z-40 mt-1 block w-56 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] p-2.5 shadow-lg">
          <span className="th mb-1.5 block">Markets (max 3)</span>
          {countries.map((cc) => (
            <label key={cc} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-[var(--bg-hover)]">
              <input
                type="checkbox"
                checked={picked.has(cc)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (e.target.checked && next.size < 3) next.add(cc);
                    else next.delete(cc);
                    return next;
                  })
                }
              />
              {cc.toUpperCase()}
            </label>
          ))}
          <button
            type="button"
            disabled={!picked.size}
            onClick={async () => {
              setError(null);
              const res = await runDiscovery(trackedAppId, [...picked]);
              if (res.error) setError(res.error);
              else {
                setOpen(false);
                router.refresh();
              }
            }}
            className="mt-2 h-8 w-full rounded-[var(--radius-chip)] bg-[var(--primary)] px-2 text-[12px] font-medium text-white disabled:opacity-50"
          >
            Start run
          </button>
          {error && <span className="mt-1 block text-[11px] text-[var(--down)]">{error}</span>}
        </span>
      )}
    </span>
  );
}

export function DiscoveredTable({
  rows,
  countries,
  trackedAppId,
  autoTrackRanked,
  latestRun = null,
}: {
  rows: DiscoveredRow[];
  countries: string[];
  trackedAppId: string;
  autoTrackRanked: boolean;
  latestRun?: DiscoveryRun;
}) {
  const [filters, setFilters] = useFilters();
  const [subTab, setSubTab] = useState("relevant");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);

  const filtered = useMemo(() => {
    let out = applyFilters(rows as any, filters) as DiscoveredRow[];
    if (subTab === "relevant") out = out.filter((r) => (r.relevance ?? 0) >= 60);
    if (subTab === "ranked") out = out.filter((r) => r.rank != null);
    if (subTab === "opportunities") out = out.filter((r) => (r.opportunity ?? 0) >= 50);
    return out;
  }, [rows, filters, subTab]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function bulk(action: "track" | "dismiss") {
    if (!selected.size) return;
    setPending(true);
    try {
      const ids = [...selected];
      if (action === "track") await promoteDiscovered(ids);
      else await dismissDiscovered(ids);
      setSelected(new Set());
    } finally {
      setPending(false);
    }
  }

  const columns = useMemo<ColumnDef<DiscoveredRow, any>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={filtered.length > 0 && selected.size === filtered.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.id)) : new Set())}
          />
        ),
        enableSorting: false,
        cell: ({ row }) => (
          <input type="checkbox" aria-label={`Select ${row.original.term}`} checked={selected.has(row.original.id)} onChange={() => toggle(row.original.id)} />
        ),
      },
      { id: "term", header: "Keyword", accessorKey: "term", cell: ({ getValue }) => <span className="text-[14px] font-medium">{String(getValue())}</span> },
      { id: "source", header: "Source", accessorKey: "source", cell: ({ getValue }) => <SourceChip source={String(getValue())} /> },
      { id: "market", header: "Market", accessorKey: "country", cell: ({ getValue }) => <CountryFlag country={getValue() as string} /> },
      {
        id: "rank",
        header: "Rank",
        accessorFn: (r) => r.rank ?? 99999,
        cell: ({ row }) => <RankPill state={{ rank: row.original.rank, found: row.original.found ?? false, last_known_rank: row.original.last_known_rank, checked: row.original.last_checked_at != null || row.original.rank != null }} />,
      },
      { id: "popularity", header: "Popularity", accessorFn: (r) => r.popularity_estimate ?? r.popularity ?? -1, cell: ({ row }) => <PopularityCell keyword={row.original as any} /> },
      { id: "difficulty", header: "Difficulty", accessorFn: (r) => r.difficulty ?? -1, cell: ({ row }) => <ScoreCell value={row.original.difficulty} label="Difficulty" /> },
      {
        id: "relevance",
        header: "Relevance",
        accessorFn: (r) => r.relevance ?? -1,
        // AI-assessed intent match, computed during discovery. '--' only until it runs.
        cell: ({ row }) => <ScoreCell value={row.original.relevance} label="Relevance" tone="var(--up)" />,
      },
      { id: "opportunity", header: "Opportunity", accessorFn: (r) => r.opportunity ?? -1, cell: ({ row }) => <ScoreCell value={row.original.opportunity} label="Opportunity" tone="var(--accent)" /> },
      {
        id: "last_checked",
        header: "Last checked",
        accessorKey: "last_checked_at",
        cell: ({ getValue }) => <span className="text-[11px] text-[var(--fg-subtle)]">{fmt.relativeDate(getValue() as string)}</span>,
      },
    ],
    [filtered, selected],
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-6 py-2">
        <div className="flex gap-1">
          {SUB_TABS.map((t) => {
            const n = t.id === "all" ? rows.length : t.id === "relevant" ? rows.filter((r) => (r.relevance ?? 0) >= 60).length : t.id === "ranked" ? rows.filter((r) => r.rank != null).length : rows.filter((r) => (r.opportunity ?? 0) >= 50).length;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSubTab(t.id)}
                aria-pressed={subTab === t.id}
                className={`rounded-[var(--radius-chip)] px-2 py-1 text-[12px] ${subTab === t.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}
              >
                {t.label} <span className="num">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <RunDiscoveryControl trackedAppId={trackedAppId} countries={countries.length ? countries : ["us"]} run={latestRun} />
          <label
            className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"
            title="Any discovered keyword found to be RANKING is promoted to Tracked by the nightly rollup, best rank first, up to 50 a day. Ideas that don't rank are never auto-tracked. Nothing has been measured as ranking yet, so this stays quiet until discovered keywords get a rank of their own."
          >
            <input
              type="checkbox"
              role="switch"
              defaultChecked={autoTrackRanked}
              onChange={(e) => setAutoTrackRanked(trackedAppId, e.target.checked)}
            />
            Auto-track ranked
          </label>
          <EstimateLegend />
        </div>
      </div>

      <FilterBar filters={filters} setFilters={setFilters} countries={countries} showType={false} showStarred={false} />

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-panel)] px-6 py-2 text-[12px]">
          <span className="num text-[var(--fg-muted)]">{selected.size} selected</span>
          <button type="button" disabled={pending} onClick={() => bulk("track")} className="rounded-[var(--radius-chip)] bg-[var(--primary)] px-2 py-1 text-white disabled:opacity-50">
            Track
          </button>
          <button type="button" disabled={pending} onClick={() => bulk("dismiss")} className="rounded-[var(--radius-chip)] border border-[var(--border)] px-2 py-1 text-[var(--fg-muted)] disabled:opacity-50">
            Dismiss
          </button>
        </div>
      )}

      <DataTable
        data={filtered}
        columns={columns}
        initialSort={[{ id: "relevance", desc: true }]}
        exportName="discovered-keywords"
        emptyState={
          <EmptyState title="Nothing discovered yet">
            Discovery runs nightly, pulling candidates from your listing, autocomplete and competitors. To run it now:{" "}
            <code className="num">npm run crawl -- --jobs discovery</code>
          </EmptyState>
        }
      />
    </div>
  );
}
