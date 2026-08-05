/**
 * StatCard — the standalone KPI card (label on top, big number, quiet sub-line) used by
 * /performance, /engagement and /client-reports. Renders null as an em dash, never 0.
 */
import * as fmt from "@/lib/format";

export function StatCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string | number | null | undefined;
  sub?: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-[12px] font-medium text-[var(--fg-subtle)]">{label}</p>
      <p className="mt-2.5 flex items-baseline gap-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums">
        {value == null || value === "" ? fmt.EM_DASH : String(value)}
        {delta}
      </p>
      {sub && <p className="mt-1.5 text-[11.5px] text-[var(--fg-subtle)]">{sub}</p>}
    </div>
  );
}
