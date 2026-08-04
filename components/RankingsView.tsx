"use client";

/**
 * /rankings — rank history (01-PRODUCT-SPEC.md §3).
 *
 * The delta columns are where the missing-≠-zero rule is most visible: '+N', '-N', '0' and
 * '--' must all look different, because "unchanged" and "we have no comparison" are not the
 * same fact.
 */
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, FilterBar, applyFilters, useFilters } from "./DataTable";
import { RankHistoryChart } from "./Charts";
import { RankPill, DeltaBadge, ScoreCell, PopularityCell, CountryFlag, Sparkline, EmptyState, EstimateLegend, Panel } from "./ui";
import * as fmt from "@/lib/format";
import type { KeywordRow } from "@/lib/queries";

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

export function RankingsView({
  rows,
  countries,
  history,
  annotations,
}: {
  rows: KeywordRow[];
  countries: string[];
  history: { keyword_id: string; term: string; country: string; checked_on: string; rank: number | null }[];
  annotations: { occurred_on: string; label: string }[];
}) {
  const [filters, setFilters] = useFilters();
  const [plotted, setPlotted] = useState<Set<string>>(new Set());
  const [granularity, setGranularity] = useState("day");
  const [range, setRange] = useState("30");
  const [compare, setCompare] = useState("off");
  const [view, setView] = useState<"keywords" | "country">("keywords");

  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);

  const series = useMemo(() => {
    const cutoff = range === "all" ? null : new Date(Date.now() - Number(range) * 86_400_000).toISOString().slice(0, 10);
    // Ghost comparison: the same keywords, one window back (or one year back), re-dated onto
    // the current axis and drawn dashed. Only meaningful with a bounded range.
    const shiftDays = compare === "off" || range === "all" ? 0 : compare === "year" ? 365 : Number(range);
    // Week/month buckets average the ranks WITH data inside each bucket; a bucket where the
    // keyword was never found stays null so the chart shows a gap, not a fake rank.
    const bucketOf = (date: string) => {
      if (granularity === "month") return `${date.slice(0, 7)}-01`;
      if (granularity === "week") {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
        return d.toISOString().slice(0, 10);
      }
      return date;
    };

    const bucketize = (raw: { date: string; rank: number | null }[]) => {
      if (granularity === "day") return raw;
      const buckets = new Map<string, (number | null)[]>();
      for (const p of raw) {
        const b = bucketOf(p.date);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b)!.push(p.rank);
      }
      return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ranks]) => {
        const found = ranks.filter((r): r is number => r != null);
        return { date, rank: found.length ? Math.round(found.reduce((s, r) => s + r, 0) / found.length) : null };
      });
    };

    const out: { term: string; country: string; points: { date: string; rank: number | null }[]; dashed?: boolean }[] = [];
    for (const key of plotted) {
      const [keywordId, country] = key.split("|");
      const term = history.find((h) => String(h.keyword_id) === keywordId)?.term ?? keywordId;
      const all = history
        .filter((h) => String(h.keyword_id) === keywordId && h.country === country)
        .map((h) => ({ date: String(h.checked_on).slice(0, 10), rank: h.rank }));

      const points = bucketize(all.filter((p) => !cutoff || p.date >= cutoff));
      if (points.length) out.push({ term, country, points });

      if (shiftDays && cutoff) {
        const shiftMs = shiftDays * 86_400_000;
        const prevCutoff = new Date(new Date(`${cutoff}T00:00:00Z`).getTime() - shiftMs).toISOString().slice(0, 10);
        const ghost = bucketize(
          all
            .filter((p) => p.date >= prevCutoff && p.date < cutoff)
            .map((p) => ({ date: new Date(new Date(`${p.date}T00:00:00Z`).getTime() + shiftMs).toISOString().slice(0, 10), rank: p.rank })),
        );
        if (ghost.length) out.push({ term: `${term} ${compare === "year" ? "(last year)" : "(prev period)"}`, country, points: ghost, dashed: true });
      }
    }
    return out;
  }, [plotted, history, range, granularity, compare]);

  const togglePlot = (row: KeywordRow) => {
    const key = `${row.keyword_id}|${row.country}`;
    setPlotted((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const columns = useMemo<ColumnDef<KeywordRow, any>[]>(
    () => [
      {
        id: "plot",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const key = `${row.original.keyword_id}|${row.original.country}`;
          const on = plotted.has(key);
          return (
            <button
              type="button"
              onClick={() => togglePlot(row.original)}
              aria-label={`Plot on chart: ${row.original.term}`}
              aria-pressed={on}
              className={`rounded px-1 text-[12px] ${on ? "text-[var(--accent)]" : "text-[var(--fg-subtle)] hover:text-[var(--fg)]"}`}
              title="Plot on chart"
            >
              {on ? "◉" : "◌"}
            </button>
          );
        },
      },
      { id: "term", header: "Keyword", accessorKey: "term", cell: ({ getValue }) => <span className="num">{String(getValue())}</span> },
      { id: "market", header: "Market", accessorKey: "country", cell: ({ getValue }) => <CountryFlag country={getValue() as string} /> },
      { id: "popularity", header: "Popularity", accessorFn: (r) => r.popularity_estimate ?? r.popularity ?? -1, cell: ({ row }) => <PopularityCell keyword={row.original} /> },
      { id: "difficulty", header: "Difficulty", accessorFn: (r) => r.difficulty ?? -1, cell: ({ row }) => <ScoreCell value={row.original.difficulty} parts={row.original.difficulty_parts} label="Difficulty breakdown" /> },
      { id: "d1", header: "1D", accessorFn: (r) => r.delta_1d ?? -9999, cell: ({ row }) => <DeltaBadge value={row.original.delta_1d} /> },
      { id: "d7", header: "7D", accessorFn: (r) => r.delta_7d ?? -9999, cell: ({ row }) => <DeltaBadge value={row.original.delta_7d} /> },
      { id: "d30", header: "30D", accessorFn: (r) => r.delta_30d ?? -9999, cell: ({ row }) => <DeltaBadge value={row.original.delta_30d} /> },
      {
        id: "avg7",
        header: "Avg 7D",
        accessorFn: (r) => r.avg_7d ?? 99999,
        // Averages are decimals over days WITH data, ignoring gaps.
        cell: ({ row }) => <span className="num text-[12px] text-[var(--fg-muted)]">{row.original.avg_7d == null ? fmt.DOUBLE_DASH : Number(row.original.avg_7d).toFixed(1)}</span>,
      },
      {
        id: "avg30",
        header: "Avg 30D",
        accessorFn: (r) => r.avg_30d ?? 99999,
        cell: ({ row }) => <span className="num text-[12px] text-[var(--fg-muted)]">{row.original.avg_30d == null ? fmt.DOUBLE_DASH : Number(row.original.avg_30d).toFixed(1)}</span>,
      },
      {
        id: "best",
        header: "Best",
        accessorFn: (r) => r.best_rank ?? 99999,
        cell: ({ row }) => <span className="num text-[12px]">{row.original.best_rank == null ? fmt.EM_DASH : `#${row.original.best_rank}`}</span>,
      },
      { id: "trend", header: "Trend", enableSorting: false, cell: ({ row }) => <Sparkline ranks={(row.original.trend ?? []) as (number | null)[]} /> },
      {
        id: "rank",
        header: "Rank",
        accessorFn: (r) => r.rank ?? 99999,
        cell: ({ row }) => {
          const r = row.original;
          return <RankPill state={{ rank: r.rank, found: r.found ?? false, last_known_rank: r.last_known_rank, crawl_depth: r.crawl_depth, checked: r.checked_at != null }} />;
        },
      },
    ],
    [plotted],
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
        <Select value={granularity} onChange={setGranularity} label="Granularity">
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </Select>
        <Select value={range} onChange={setRange} label="Date range">
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </Select>
        <Select value={compare} onChange={setCompare} label="Compare against">
          <option value="off">No comparison</option>
          <option value="prev" disabled={range === "all"}>vs previous period</option>
          <option value="year" disabled={range === "all"}>vs same period last year</option>
        </Select>
        <div className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {(["keywords", "country"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className={`rounded-[5px] px-2 py-0.5 text-[12px] ${view === v ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}>
              {v === "keywords" ? "Keywords" : "By country"}
            </button>
          ))}
        </div>
        <EstimateLegend />
      </div>

      <div className="p-6 pb-0">
        <Panel title="Rank history" caption="Click ◌ on any row to plot it. Version releases appear as numbered pins.">
          <RankHistoryChart series={series} annotations={annotations} />
        </Panel>
      </div>

      <FilterBar filters={filters} setFilters={setFilters} countries={countries} showType={false} />

      <DataTable
        data={filtered}
        columns={columns}
        initialSort={[{ id: "rank", desc: false }]}
        exportName="rankings"
        exportRows={(rs) =>
          rs.map((r) => ({
            keyword: r.term,
            store: fmt.storeLabel(r.platform),
            country: r.country,
            rank: r.rank,
            rank_state: fmt.rank({ rank: r.rank, found: r.found ?? false, last_known_rank: r.last_known_rank, crawl_depth: r.crawl_depth }),
            delta_1d: r.delta_1d,
            delta_7d: r.delta_7d,
            delta_30d: r.delta_30d,
            avg_7d: r.avg_7d,
            avg_30d: r.avg_30d,
            best_rank: r.best_rank,
            popularity: r.popularity_estimate ?? r.popularity,
            difficulty: r.difficulty,
          }))
        }
        emptyState={<EmptyState title="No rank history yet">Run the crawler to start building daily history.</EmptyState>}
      />
    </div>
  );
}

function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px] text-[var(--fg-muted)]">
      {children}
    </select>
  );
}
