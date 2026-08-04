"use client";

/**
 * The /keywords Tracked tab table and the Matrix view — 01-PRODUCT-SPEC.md §2.1 and §2.2.
 *
 * Cell rendering here is where the product's rules become visible:
 *   - Rank has FOUR distinct states and they must stay distinguishable
 *   - Popularity renders '5 (28)' when the store floors the value and we substitute
 *   - Every score has an ⓘ showing the components that produced it
 */
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, FilterBar, applyFilters, useFilters } from "./DataTable";
import { RankPill, DeltaBadge, ScoreCell, PopularityCell, Chip, CountryFlag, AppIconStrip, Sparkline, EmptyState, EstimateLegend, SOURCE_LABELS } from "./ui";
import * as fmt from "@/lib/format";
import { quadrantFor, QUADRANT_LABELS } from "@/lib/scoring/scores.mjs";
import { untrackKeywords } from "@/app/actions/keywords";
import type { KeywordRow } from "@/lib/queries";

const SOURCES = [
  { value: "manual", label: "Manual" },
  { value: "suggested", label: "Suggested" },
  { value: "competitor", label: "Competitor" },
  { value: "autocomplete", label: "Autocomplete" },
];

export function KeywordsTable({ rows, countries }: { rows: KeywordRow[]; countries: string[] }) {
  const [filters, setFilters] = useFilters();
  const [view, setView] = useState<"table" | "matrix">("table");
  const [thresholds, setThresholds] = useState({ difficulty: 50, popularity: 25 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);

  const filtered = useMemo(() => {
    let out = applyFilters(rows, filters);
    if (filters.quadrant !== "all") {
      out = out.filter((r) => quadrantFor({ difficulty: r.difficulty, popularity: r.popularity_estimate ?? r.popularity }, { difficultySplit: thresholds.difficulty, popularitySplit: thresholds.popularity }) === filters.quadrant);
    }
    return out;
  }, [rows, filters, thresholds]);

  async function untrackSelected() {
    if (!selected.size) return;
    if (!window.confirm(`Stop tracking ${selected.size} keyword${selected.size === 1 ? "" : "s"}?\n\nMeasured ranks and scores are shared across the workspace and stay — re-adding a keyword picks its history back up.`)) return;
    setPending(true);
    try {
      await untrackKeywords([...selected]);
      setSelected(new Set());
    } finally {
      setPending(false);
    }
  }

  const columns = useMemo<ColumnDef<KeywordRow, any>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all"
            checked={filtered.length > 0 && selected.size === filtered.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.tracked_keyword_id)) : new Set())}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.term}`}
            checked={selected.has(row.original.tracked_keyword_id)}
            onChange={() =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(row.original.tracked_keyword_id)) next.delete(row.original.tracked_keyword_id);
                else next.add(row.original.tracked_keyword_id);
                return next;
              })
            }
          />
        ),
      },
      {
        id: "term",
        header: "Keyword",
        accessorKey: "term",
        cell: ({ row }) => {
          const r = row.original;
          const beatable = (r.difficulty_parts as any)?.beatable_value === true;
          const evidence = (r.difficulty_parts as any)?.beatable?.reason;
          return (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[14px] font-medium text-[var(--fg)]">{r.term}</span>
              <Chip tone={r.is_branded ? "branded" : "neutral"}>{r.is_branded ? "Branded" : "Generic"}</Chip>
              {beatable && (
                <Chip tone="beatable" title={evidence ?? "A top-3 slot looks winnable"}>
                  Beatable
                </Chip>
              )}
              {r.serp_outlier && (
                <Chip tone="warn" title="An app in the top 10 ranks with far less social proof than the field — strong metadata. Worth studying.">
                  Outlier
                </Chip>
              )}
            </div>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessorKey: "source",
        cell: ({ getValue }) => <Chip>{SOURCE_LABELS[getValue() as string] ?? String(getValue())}</Chip>,
      },
      {
        id: "updated",
        header: "Updated",
        accessorKey: "metrics_updated_at",
        cell: ({ getValue }) => <span className="text-[11px] text-[var(--fg-subtle)]">{fmt.relativeDate(getValue() as string)}</span>,
      },
      {
        id: "market",
        header: "Market",
        accessorKey: "country",
        cell: ({ getValue }) => <CountryFlag country={getValue() as string} />,
      },
      {
        id: "popularity",
        header: "Popularity",
        accessorFn: (r) => r.popularity_estimate ?? r.popularity ?? -1,
        cell: ({ row }) => <PopularityCell keyword={row.original} />,
      },
      {
        id: "est_downloads",
        header: "Est. #1 downloads",
        accessorKey: "est_downloads_rank1",
        cell: ({ getValue }) => {
          const v = getValue() as number | null;
          return (
            <span className="num text-[12px] text-[var(--fg-muted)]" title="Modelled from an industry SP→impressions curve, not measured. Order of magnitude only.">
              {v == null ? fmt.EM_DASH : `~${fmt.count(v)}`}
            </span>
          );
        },
      },
      {
        id: "difficulty",
        header: "Difficulty",
        accessorFn: (r) => r.difficulty ?? -1,
        cell: ({ row }) => (
          <ScoreCell
            value={row.original.difficulty}
            parts={row.original.difficulty_parts}
            label="Difficulty breakdown"
            tone={difficultyTone(row.original.difficulty)}
          />
        ),
      },
      {
        id: "gap",
        header: "Gap",
        accessorFn: (r) => r.gap ?? -999,
        cell: ({ row }) => {
          const g = row.original.gap;
          return (
            <span
              className="num text-[12px]"
              style={{ color: g == null ? "var(--fg-subtle)" : g > 0 ? "var(--up)" : "var(--down)" }}
              title="Demand minus competition. Positive is the sweet spot."
            >
              {fmt.gap(g)}
            </span>
          );
        },
      },
      {
        id: "top_results",
        header: "Top Results",
        enableSorting: false,
        cell: ({ row }) => <AppIconStrip apps={row.original.top_apps ?? []} />,
      },
      {
        id: "rank",
        header: "Rank",
        accessorFn: (r) => r.rank ?? 99999,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-center gap-2">
              <RankPill state={{ rank: r.rank, found: r.found ?? false, last_known_rank: r.last_known_rank, crawl_depth: r.crawl_depth, checked: r.checked_at != null }} />
              <DeltaBadge value={r.delta_1d} showZero={false} />
            </div>
          );
        },
      },
    ],
    [filtered, selected],
  );

  const counts = useMemo(() => {
    const base = applyFilters(rows, { ...filters, quadrant: "all" });
    const out: Record<string, number> = { quick_wins: 0, worth_fighting: 0, easy_pickings: 0, low_priority: 0 };
    for (const r of base) {
      const qd = quadrantFor({ difficulty: r.difficulty, popularity: r.popularity_estimate ?? r.popularity }, { difficultySplit: thresholds.difficulty, popularitySplit: thresholds.popularity });
      if (qd) out[qd]++;
    }
    return out;
  }, [rows, filters, thresholds]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-6 py-2">
        <div className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {(["table", "matrix"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-[5px] px-2 py-1 text-[12px] ${view === v ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}
            >
              {v === "table" ? "Table view" : "Matrix view"}
            </button>
          ))}
        </div>
        <EstimateLegend />
      </div>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        countries={countries}
        sources={view === "table" ? SOURCES : undefined}
        showType={view === "table"}
        showStarred={view === "table"}
        showNumeric={view === "table"}
      />

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-panel)] px-6 py-2 text-[12px]">
          <span className="num text-[var(--fg-muted)]">{selected.size} selected</span>
          <button
            type="button"
            disabled={pending}
            onClick={untrackSelected}
            className="rounded-[var(--radius-chip)] border border-[var(--border)] px-2 py-1 text-[var(--fg-muted)] hover:border-[var(--down)] hover:text-[var(--down)] disabled:opacity-50"
          >
            {pending ? "Removing…" : "Untrack"}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-[var(--fg-subtle)] hover:text-[var(--fg)]">
            Clear
          </button>
        </div>
      )}

      {view === "matrix" && (
        <MatrixView rows={filtered} allRows={rows} thresholds={thresholds} setThresholds={setThresholds} counts={counts} filters={filters} setFilters={setFilters} />
      )}

      <DataTable
        data={filtered}
        columns={columns}
        // "Est. #1 downloads" is off by default and labelled as an estimate.
        defaultHidden={{ est_downloads: false }}
        initialSort={[{ id: "rank", desc: false }]}
        exportName="keywords"
        exportRows={(rs) =>
          rs.map((r) => ({
            keyword: r.term,
            store: r.platform === "ios" ? "App Store" : "Google Play",
            country: r.country,
            source: r.source,
            popularity_store: r.popularity,
            popularity_estimate: r.popularity_estimate,
            difficulty: r.difficulty,
            gap: r.gap,
            rank: r.rank,
            rank_state: fmt.rank({ rank: r.rank, found: r.found ?? false, last_known_rank: r.last_known_rank, crawl_depth: r.crawl_depth }),
            delta_1d: r.delta_1d,
            delta_7d: r.delta_7d,
            best_rank: r.best_rank,
            branded: r.is_branded,
            updated: r.metrics_updated_at,
          }))
        }
        emptyState={
          <EmptyState title="No keywords tracked yet">
            Use <strong>+ Add Keywords</strong> above — one term per line. Scores and ranks fill in on the next crawl.
          </EmptyState>
        }
      />
    </div>
  );
}

function difficultyTone(d: number | null) {
  if (d == null) return undefined;
  if (d >= 75) return "var(--down)";
  if (d >= 55) return "var(--rank-31-100)";
  if (d >= 35) return "var(--rank-11-30)";
  return "var(--up)";
}

/**
 * Matrix view — x = Difficulty, y = Popularity, four quadrants split by DRAGGABLE thresholds.
 * Filled dot = ranked, hollow = not ranked.
 */
function MatrixView({
  rows,
  allRows,
  thresholds,
  setThresholds,
  counts,
  filters,
  setFilters,
}: {
  rows: KeywordRow[];
  allRows: KeywordRow[];
  thresholds: { difficulty: number; popularity: number };
  setThresholds: (t: { difficulty: number; popularity: number }) => void;
  counts: Record<string, number>;
  filters: any;
  setFilters: (p: any) => void;
}) {
  const W = 620;
  const H = 320;
  const PAD = 32;

  const plottable = allRows.filter((r) => r.difficulty != null && (r.popularity_estimate ?? r.popularity) != null);
  const x = (d: number) => PAD + (d / 100) * (W - PAD * 2);
  const y = (p: number) => H - PAD - (p / 100) * (H - PAD * 2);

  return (
    <div className="border-b border-[var(--border)] px-6 py-4">
      <svg width={W} height={H} className="max-w-full" role="img" aria-label="Keyword opportunity matrix: difficulty against popularity">
        <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2} fill="var(--bg-panel)" stroke="var(--border)" />

        {/* Quadrant dividers — the draggable thresholds */}
        <line x1={x(thresholds.difficulty)} y1={PAD} x2={x(thresholds.difficulty)} y2={H - PAD} stroke="var(--border-strong)" strokeDasharray="4 3" />
        <line x1={PAD} y1={y(thresholds.popularity)} x2={W - PAD} y2={y(thresholds.popularity)} stroke="var(--border-strong)" strokeDasharray="4 3" />

        <text x={PAD + 6} y={PAD + 14} className="th" fill="var(--fg-subtle)" fontSize="9">QUICK WINS</text>
        <text x={W - PAD - 6} y={PAD + 14} textAnchor="end" className="th" fill="var(--fg-subtle)" fontSize="9">WORTH FIGHTING</text>
        <text x={PAD + 6} y={H - PAD - 6} className="th" fill="var(--fg-subtle)" fontSize="9">EASY PICKINGS</text>
        <text x={W - PAD - 6} y={H - PAD - 6} textAnchor="end" className="th" fill="var(--fg-subtle)" fontSize="9">LOW PRIORITY</text>

        {plottable.map((r) => {
          const pop = (r.popularity_estimate ?? r.popularity) as number;
          const ranked = r.rank != null;
          const visible = rows.includes(r);
          return (
            <circle
              key={`${r.keyword_id}-${r.country}`}
              cx={x(r.difficulty as number)}
              cy={y(pop)}
              r={4}
              // Filled = ranked, hollow = not ranked.
              fill={ranked ? "var(--accent)" : "none"}
              stroke="var(--accent)"
              strokeWidth={1.4}
              opacity={visible ? 0.95 : 0.15}
            >
              <title>{`${r.term} (${r.country.toUpperCase()}) — difficulty ${r.difficulty}, popularity ${pop}${ranked ? `, #${r.rank}` : ", not ranked"}`}</title>
            </circle>
          );
        })}

        <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--fg-subtle)">Difficulty (0–100)</text>
        <text x={10} y={H / 2} textAnchor="middle" fontSize="10" fill="var(--fg-subtle)" transform={`rotate(-90 10 ${H / 2})`}>Popularity (0–100)</text>
      </svg>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
          Difficulty split
          <input type="range" min={0} max={100} value={thresholds.difficulty} onChange={(e) => setThresholds({ ...thresholds, difficulty: Number(e.target.value) })} className="w-24" aria-label="Difficulty threshold" />
          <span className="num">{thresholds.difficulty}</span>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
          Popularity split
          <input type="range" min={0} max={100} value={thresholds.popularity} onChange={(e) => setThresholds({ ...thresholds, popularity: Number(e.target.value) })} className="w-24" aria-label="Popularity threshold" />
          <span className="num">{thresholds.popularity}</span>
        </label>
        <span className="text-[11px] text-[var(--fg-subtle)]">● ranked · ○ not ranked · ( ) = estimate</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(QUADRANT_LABELS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilters({ quadrant: filters.quadrant === key ? "all" : key })}
            aria-pressed={filters.quadrant === key}
            className={`rounded-[var(--radius-chip)] border px-2 py-1 text-[11px] ${filters.quadrant === key ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}
          >
            {label} <span className="num">{counts[key] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
