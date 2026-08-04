"use client";

/**
 * Charts — 06-FRONTEND-SPEC.md §3.4, on recharts (the house choice).
 *
 * Chart rules enforced here:
 *   - INVERTED y-axis for anything rank-based (rank 1 at the top)
 *   - never interpolate across missing days: connectNulls={false}, leave the gap
 *   - tooltips state the country, axis labels always carry units or '#'
 *   - a screen-reader data-table fallback accompanies every chart
 */
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useState } from "react";
import { shortDate } from "@/lib/format";

const AXIS = { stroke: "var(--fg-subtle)", fontSize: 10 };
const GRID = { stroke: "var(--border)", strokeDasharray: "3 3" };

const tooltipStyle = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--fg)",
};

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">{children}</p>;
}

/** Accessible fallback: the same numbers as a real table, hidden visually. */
function DataTableFallback({ rows, label }: { rows: Record<string, unknown>[]; label: string }) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <thead>
        <tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? "no data")}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

export function VisibilityChart({ data }: { data: { metric_on: string; visibility: number | null }[] }) {
  const rows = data.map((d) => ({ date: shortDate(d.metric_on), visibility: d.visibility == null ? null : Number(d.visibility) }));
  return (
    <>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={rows} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} {...AXIS} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [v as number, "Visibility (0–100)"]} />
          {/* connectNulls={false}: a day we did not measure must show as a gap, not a straight line. */}
          <Area type="monotone" dataKey="visibility" stroke="var(--chart)" fill="var(--chart-soft)" strokeWidth={1.6} connectNulls={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <Caption>Popularity-weighted rank reach, last 30 days. 0–100.</Caption>
      <DataTableFallback rows={rows} label="Visibility over the last 30 days" />
    </>
  );
}

export function ShareOfVoiceChart({ data }: { data: { metric_on: string; share_of_voice: number | null }[] }) {
  const rows = data.map((d) => ({ date: shortDate(d.metric_on), sov: d.share_of_voice == null ? null : Number(d.share_of_voice) }));
  return (
    <>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={rows} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} unit="%" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}%`, "Share of voice"]} />
          <Line type="monotone" dataKey="sov" stroke="var(--chart)" strokeWidth={1.6} connectNulls={false} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <Caption>% of tracked non-branded demand captured, last 30 days.</Caption>
      <DataTableFallback rows={rows} label="Share of voice over the last 30 days" />
    </>
  );
}

const BRACKETS = [
  { key: "top3_count", label: "Top 3", colour: "var(--rank-top3)" },
  { key: "b4_10", label: "4–10", colour: "var(--rank-4-10)" },
  { key: "bracket_11_30", label: "11–30", colour: "var(--rank-11-30)" },
  { key: "bracket_31_100", label: "31–100", colour: "var(--rank-31-100)" },
  { key: "bracket_100_plus", label: "100+", colour: "var(--rank-100plus)" },
];

/**
 * RankDistributionPanel — the stacked distribution with two switches: count vs
 * popularity-weighted stacks, and everything vs starred targets only.
 * (Starred + weighted falls back to starred counts: weighting a starred subset would need
 * a fourth series family for marginal insight.)
 */
export function RankDistributionPanel({ data }: { data: Record<string, unknown>[] }) {
  const [weighted, setWeighted] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const prefix = starredOnly ? "s" : weighted ? "w" : "c";
  const rows = data.map((d) => ({
    metric_on: d.metric_on,
    top3_count: Number(d[`${prefix}1`] ?? 0),
    top10_count: Number(d[`${prefix}1`] ?? 0) + Number(d[`${prefix}2`] ?? 0),
    bracket_11_30: Number(d[`${prefix}3`] ?? 0),
    bracket_31_100: Number(d[`${prefix}4`] ?? 0),
    bracket_100_plus: Number(d[`${prefix}5`] ?? 0),
  }));
  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setStarredOnly((s) => !s)}
          aria-pressed={starredOnly}
          className={`h-7 rounded-[8px] border px-2.5 text-[12px] ${starredOnly ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
        >
          ☆ Starred
        </button>
        <span className="inline-flex items-center gap-0.5 rounded-[9px] bg-[var(--bg-hover)] p-0.5">
          {([
            ["Trend", false],
            ["Weighted", true],
          ] as const).map(([label, w]) => (
            <button
              key={label}
              type="button"
              onClick={() => setWeighted(w)}
              aria-pressed={weighted === w}
              className={`rounded-[7px] px-2.5 py-1 text-[12px] font-medium ${weighted === w ? "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] shadow-sm" : "text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <BracketAreaChart data={rows} />
      {weighted && !starredOnly && <Caption>Stacks sum the popularity of the keywords in each bracket instead of counting them.</Caption>}
    </>
  );
}

/** Five stacked series in the SAME bracket colours the rank pills use. */
export function BracketAreaChart({ data }: { data: any[] }) {
  const rows = data.map((d) => ({
    date: shortDate(d.metric_on),
    top3_count: d.top3_count ?? 0,
    b4_10: Math.max(0, (d.top10_count ?? 0) - (d.top3_count ?? 0)),
    bracket_11_30: d.bracket_11_30 ?? 0,
    bracket_31_100: d.bracket_31_100 ?? 0,
    bracket_100_plus: d.bracket_100_plus ?? 0,
  }));
  return (
    <>
      <ResponsiveContainer width="100%" height={190}>
        <AreaChart data={rows} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          {BRACKETS.map((b) => (
            <Area key={b.key} type="monotone" dataKey={b.key} name={b.label} stackId="1" stroke={b.colour} fill={b.colour} fillOpacity={0.55} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <Caption>Ranked keywords by rank bracket, last 30 days. Unranked keywords are excluded entirely.</Caption>
      <DataTableFallback rows={rows} label="Ranked keywords by bracket" />
    </>
  );
}

/**
 * RankHistoryChart — multi-series rank over time with an INVERTED y-axis (rank #1 at the top)
 * and numbered annotation pins for app events.
 */
export function RankHistoryChart({
  series,
  annotations = [],
}: {
  series: { term: string; country: string; points: { date: string; rank: number | null }[]; dashed?: boolean }[];
  annotations?: { occurred_on: string; label: string }[];
}) {
  if (!series.length) {
    return <p className="py-8 text-center text-[12px] text-[var(--fg-subtle)]">Use “Plot on chart” on any row to add a keyword here.</p>;
  }

  // Merge into one date-keyed frame so recharts can align the series.
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const rows = dates.map((date) => {
    const row: Record<string, unknown> = { date: shortDate(date), iso: date };
    for (const s of series) {
      row[`${s.term} (${s.country.toUpperCase()})`] = s.points.find((p) => p.date === date)?.rank ?? null;
    }
    return row;
  });

  const allRanks = series.flatMap((s) => s.points.map((p) => p.rank).filter((r): r is number => r != null));
  const worst = allRanks.length ? Math.max(...allRanks) : 100;

  const COLOURS = ["var(--accent)", "var(--up)", "var(--warn)", "#a855f7", "#06b6d4", "#f43f5e"];
  const pins = annotations.map((a, i) => ({ ...a, n: i + 1, x: shortDate(a.occurred_on) }));

  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          {/* INVERTED: rank #1 sits at the top, because a smaller rank is better. */}
          <YAxis reversed domain={[1, Math.max(10, worst)]} {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => `#${v}`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [v == null ? "not ranked" : `#${v}`, name as string]} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          {pins.map((p) => (
            <ReferenceLine key={p.n} x={p.x} stroke="var(--border-strong)" strokeDasharray="3 3" label={{ value: String(p.n), position: "top", fill: "var(--fg-subtle)", fontSize: 9 }} />
          ))}
          {series.map((s, i) => (
            <Line
              key={`${s.term}-${s.country}`}
              type="monotone"
              dataKey={`${s.term} (${s.country.toUpperCase()})`}
              stroke={COLOURS[i % COLOURS.length]}
              strokeWidth={s.dashed ? 1.2 : 1.6}
              strokeDasharray={s.dashed ? "4 4" : undefined}
              strokeOpacity={s.dashed ? 0.55 : 1}
              dot={s.dashed ? false : { r: 2 }}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      {pins.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-3">
          {pins.map((p) => (
            <span key={p.n} className={`text-[11px] ${(p as { auto?: boolean }).auto ? "italic text-[var(--fg-subtle)]" : "text-[var(--fg-muted)]"}`}>
              <span className="num not-italic">{p.n}</span> · {shortDate(p.occurred_on)} · {p.label}
              {(p as { auto?: boolean }).auto && <span className="ml-1 rounded-full bg-[var(--bg-hover)] px-1.5 text-[9px] not-italic">detected</span>}
            </span>
          ))}
        </div>
      )}
      <Caption>Rank over time, y-axis inverted so #1 is at the top. Gaps are days with no measurement, never interpolated.</Caption>
      <DataTableFallback rows={rows} label="Rank history" />
    </>
  );
}

export function MiniBarChart({ data, dataKey, label, colour = "var(--accent)" }: { data: any[]; dataKey: string; label: string; colour?: string }) {
  return (
    <>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey={dataKey} fill={colour} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <Caption>{label}</Caption>
    </>
  );
}
