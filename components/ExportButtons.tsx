"use client";

/** CSV/JSON download for server-rendered tables (DataTable has its own; this is for the rest). */
import { toCsv } from "@/lib/format";

export function ExportButtons({ rows, name }: { rows: Record<string, unknown>[]; name: string }) {
  function download(format: "csv" | "json") {
    const body = format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2);
    const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!rows.length) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => download("csv")} className="h-8 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
        Export CSV
      </button>
      <button type="button" onClick={() => download("json")} className="h-8 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
        JSON
      </button>
    </span>
  );
}
