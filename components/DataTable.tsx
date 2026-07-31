"use client";

/**
 * One DataTable + FilterBar for the whole product — 06-FRONTEND-SPEC.md §3.3.
 *
 * Built on TanStack Table because six tables need sorting, column visibility and pagination,
 * and hand-rolling that three times is the slower path.
 *
 * All filter state is serialised into the URL query string, so a view is shareable and
 * survives a refresh.
 */
import { useMemo, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { toCsv } from "@/lib/format";

export type FilterState = {
  text: string;
  regex: boolean;
  source: string;
  rankState: string;
  starred: boolean;
  type: string;
  countries: string[];
  minPop: string;
  maxDiff: string;
  quadrant: string;
};

export const EMPTY_FILTERS: FilterState = {
  text: "",
  regex: false,
  source: "all",
  rankState: "all",
  starred: false,
  type: "all",
  countries: [],
  minPop: "",
  maxDiff: "",
  quadrant: "all",
};

/** Reads filter state out of the URL so views are shareable and survive a refresh. */
export function useFilters(): [FilterState, (patch: Partial<FilterState>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters: FilterState = useMemo(
    () => ({
      text: params.get("q") ?? "",
      regex: params.get("re") === "1",
      source: params.get("source") ?? "all",
      rankState: params.get("rank") ?? "all",
      starred: params.get("starred") === "1",
      type: params.get("type") ?? "all",
      countries: params.get("cc")?.split(",").filter(Boolean) ?? [],
      minPop: params.get("pop") ?? "",
      maxDiff: params.get("diff") ?? "",
      quadrant: params.get("quad") ?? "all",
    }),
    [params],
  );

  const setFilters = useCallback(
    (patch: Partial<FilterState>) => {
      const next = { ...filters, ...patch };
      const sp = new URLSearchParams();
      if (next.text) sp.set("q", next.text);
      if (next.regex) sp.set("re", "1");
      if (next.source !== "all") sp.set("source", next.source);
      if (next.rankState !== "all") sp.set("rank", next.rankState);
      if (next.starred) sp.set("starred", "1");
      if (next.type !== "all") sp.set("type", next.type);
      if (next.countries.length) sp.set("cc", next.countries.join(","));
      if (next.minPop) sp.set("pop", next.minPop);
      if (next.maxDiff) sp.set("diff", next.maxDiff);
      if (next.quadrant !== "all") sp.set("quad", next.quadrant);
      const app = params.get("app");
      if (app) sp.set("app", app);
      router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`, { scroll: false });
    },
    [filters, params, pathname, router],
  );

  return [filters, setFilters];
}

/** Applies the filter state to a row set. Shared by every table so semantics never drift. */
export function applyFilters<T extends Record<string, any>>(rows: T[], f: FilterState): T[] {
  let out = rows;

  if (f.text) {
    if (f.regex) {
      try {
        const re = new RegExp(f.text, "i");
        out = out.filter((r) => re.test(String(r.term ?? "")));
      } catch {
        // An in-progress regex is a normal state while typing, not an error to shout about.
      }
    } else {
      const needle = f.text.toLowerCase();
      out = out.filter((r) => String(r.term ?? "").toLowerCase().includes(needle));
    }
  }

  if (f.source !== "all") out = out.filter((r) => r.source === f.source);
  if (f.starred) out = out.filter((r) => r.starred);
  if (f.type !== "all") out = out.filter((r) => (f.type === "branded" ? r.is_branded : !r.is_branded));
  if (f.countries.length) out = out.filter((r) => f.countries.includes(r.country));

  if (f.rankState === "ranking") out = out.filter((r) => r.rank != null);
  else if (f.rankState === "not-ranking") out = out.filter((r) => r.rank == null);

  if (f.minPop) {
    const min = Number(f.minPop);
    out = out.filter((r) => {
      const p = r.popularity_estimate ?? r.popularity;
      return p != null && p >= min;
    });
  }
  if (f.maxDiff) {
    const max = Number(f.maxDiff);
    // A null difficulty is NOT <= max — unmeasured is not the same as easy.
    out = out.filter((r) => r.difficulty != null && r.difficulty <= max);
  }

  return out;
}

export function FilterBar({
  filters,
  setFilters,
  countries,
  sources,
  showType = true,
  showStarred = true,
  showNumeric = true,
  extra,
}: {
  filters: FilterState;
  setFilters: (p: Partial<FilterState>) => void;
  countries: string[];
  sources?: { value: string; label: string }[];
  showType?: boolean;
  showStarred?: boolean;
  showNumeric?: boolean;
  extra?: React.ReactNode;
}) {
  const [text, setText] = useState(filters.text);
  useEffect(() => setText(filters.text), [filters.text]);

  // Debounce typing so every keystroke does not push a history entry.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== filters.text) setFilters({ text });
    }, 250);
    return () => clearTimeout(t);
  }, [text, filters.text, setFilters]);

  const regexInvalid = filters.regex && text ? !isValidRegex(text) : false;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
      <div className="relative flex items-center">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter keywords…"
          aria-label="Filter keywords"
          className={`h-7 w-52 rounded-[var(--radius-chip)] border bg-[var(--bg-elevated)] pl-2 pr-8 text-[12px] ${regexInvalid ? "border-[var(--down)]" : "border-[var(--border)]"}`}
        />
        <button
          type="button"
          onClick={() => setFilters({ regex: !filters.regex })}
          aria-label="Click for regex mode"
          aria-pressed={filters.regex}
          title={filters.regex ? "Regex mode on" : "Click for regex mode"}
          className={`num absolute right-1 rounded px-1 text-[10px] ${filters.regex ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`}
        >
          .*
        </button>
      </div>

      {sources && (
        <Select value={filters.source} onChange={(v) => setFilters({ source: v })} label="Source">
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
      )}

      <Select value={filters.rankState} onChange={(v) => setFilters({ rankState: v })} label="Rank state">
        <option value="all">All ranks</option>
        <option value="ranking">Ranking</option>
        <option value="not-ranking">Not ranking</option>
      </Select>

      {showStarred && (
        <button
          type="button"
          onClick={() => setFilters({ starred: !filters.starred })}
          aria-label="Show starred keywords only"
          aria-pressed={filters.starred}
          className={`h-7 rounded-[var(--radius-chip)] border px-2 text-[12px] ${filters.starred ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}
        >
          ★ Starred
        </button>
      )}

      {showType && (
        <Select value={filters.type} onChange={(v) => setFilters({ type: v })} label="Keyword type">
          <option value="all">All types</option>
          <option value="branded">Branded</option>
          <option value="generic">Generic</option>
        </Select>
      )}

      {countries.length > 1 && (
        <details className="relative">
          <summary className="flex h-7 cursor-pointer list-none items-center rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)]">
            {filters.countries.length ? `${filters.countries.length} market(s)` : "All markets"}
          </summary>
          <div className="absolute left-0 top-full z-40 mt-1 w-40 rounded-[var(--radius-chip)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1.5 shadow-xl">
            {countries.map((cc) => (
              <label key={cc} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]">
                <input
                  type="checkbox"
                  checked={filters.countries.includes(cc)}
                  onChange={(e) =>
                    setFilters({
                      countries: e.target.checked
                        ? [...filters.countries, cc]
                        : filters.countries.filter((c) => c !== cc),
                    })
                  }
                />
                {cc.toUpperCase()}
              </label>
            ))}
          </div>
        </details>
      )}

      {showNumeric && (
        <>
          <NumberInput label="Pop ≥" value={filters.minPop} onChange={(v) => setFilters({ minPop: v })} />
          <NumberInput label="Diff ≤" value={filters.maxDiff} onChange={(v) => setFilters({ maxDiff: v })} />
        </>
      )}

      {extra}
    </div>
  );
}

function isValidRegex(s: string) {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px] text-[var(--fg-muted)]"
    >
      {children}
    </select>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex h-7 items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px] text-[var(--fg-subtle)]">
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="num w-12 bg-transparent text-[12px] text-[var(--fg)] outline-none"
      />
    </label>
  );
}

const PAGE_SIZES = [10, 25, 50, 100, 250];

export function DataTable<T extends Record<string, any>>({
  data,
  columns,
  defaultHidden = {},
  exportName = "export",
  exportRows,
  emptyState,
  initialSort,
}: {
  data: T[];
  columns: ColumnDef<T, any>[];
  defaultHidden?: VisibilityState;
  exportName?: string;
  exportRows?: (rows: T[]) => Record<string, unknown>[];
  emptyState?: React.ReactNode;
  initialSort?: SortingState;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const [visibility, setVisibility] = useState<VisibilityState>(defaultHidden);
  const [pageSize, setPageSize] = useState(50);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility: visibility, pagination: { pageIndex: 0, pageSize } },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
  });

  const rows = table.getRowModel().rows;
  const total = data.length;
  const pageIndex = table.getState().pagination.pageIndex;
  const from = total === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min((pageIndex + 1) * pageSize, total);

  function download(format: "csv" | "json") {
    const source = exportRows ? exportRows(data) : (data as Record<string, unknown>[]);
    const body = format === "csv" ? toCsv(source) : JSON.stringify(source, null, 2);
    const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName}-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!total && emptyState) return <div className="p-6">{emptyState}</div>;

  return (
    <div>
      <div className="flex items-center justify-end gap-2 px-6 py-2">
        <details className="relative">
          <summary className="flex h-7 cursor-pointer list-none items-center rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)]">
            Columns
          </summary>
          <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-[var(--radius-chip)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1.5 shadow-xl">
            {table.getAllLeafColumns().map((col) => (
              <label key={col.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]">
                <input type="checkbox" checked={col.getIsVisible()} onChange={col.getToggleVisibilityHandler()} />
                {typeof col.columnDef.header === "string" ? col.columnDef.header : col.id}
              </label>
            ))}
            <button
              type="button"
              onClick={() => setVisibility(defaultHidden)}
              className="mt-1 w-full rounded border-t border-[var(--border)] px-1.5 py-1 text-left text-[11px] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            >
              Reset to default
            </button>
          </div>
        </details>

        <button type="button" onClick={() => download("csv")} className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
          Export CSV
        </button>
        <button type="button" onClick={() => download("json")} className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
          JSON
        </button>
      </div>

      {/* Horizontal scroll lives INSIDE this container — the page body must never scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--bg)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-[var(--border)]">
                {hg.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                      className="th whitespace-nowrap px-3 py-2 text-left"
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-[var(--fg)]"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span aria-hidden className="text-[9px] opacity-60">{sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : "↕"}</span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-panel)]">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 align-middle" style={{ height: 44 }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={table.getAllLeafColumns().length} className="px-3 py-8 text-center text-[12px] text-[var(--fg-subtle)]">
                  No rows match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 px-6 py-2.5 text-[12px] text-[var(--fg-subtle)]">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            Rows
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="Rows per page"
              className="rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1 py-0.5"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <span className="num">{from}–{to} of {total}</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page" className="rounded px-2 py-1 disabled:opacity-30 hover:text-[var(--fg)]">
            ‹ Prev
          </button>
          <button type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page" className="rounded px-2 py-1 disabled:opacity-30 hover:text-[var(--fg)]">
            Next ›
          </button>
        </div>
      </div>
    </div>
  );
}
