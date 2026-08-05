"use client";

/**
 * TrendAreaChart — a generic daily-series area chart for the ASC pages (/performance,
 * /engagement), following the same rules as components/Charts.tsx: never interpolate
 * across missing days (connectNulls={false}), axis/tooltip styles from CSS vars, and a
 * screen-reader table fallback.
 */
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
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

export function TrendAreaChart({
  data,
  series,
  height = 200,
  tickPrefix = "",
}: {
  data: Record<string, unknown>[];
  series: { key: string; label: string; colour: string }[];
  height?: number;
  tickPrefix?: string;
}) {
  const rows = data.map((d) => {
    const row: Record<string, unknown> = { date: shortDate(d.metric_on as string) };
    for (const s of series) row[s.key] = d[s.key] == null ? null : Number(d[s.key]);
    return row;
  });
  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickLine={false} axisLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => `${tickPrefix}${v}`} />
          <Tooltip contentStyle={tooltipStyle} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.colour}
              fill={s.colour}
              fillOpacity={0.16}
              strokeWidth={1.6}
              connectNulls={false}
              dot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {rows.length > 0 && (
        <table className="sr-only">
          <caption>Daily values</caption>
          <thead>
            <tr>
              <th scope="col">date</th>
              {series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{String(r.date)}</td>
                {series.map((s) => <td key={s.key}>{String(r[s.key] ?? "no data")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
