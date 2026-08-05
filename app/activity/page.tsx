/**
 * /activity — 01-PRODUCT-SPEC.md §6.
 *
 * Detection is diff-based: the crawler snapshots each tracked app daily and emits an event
 * whenever a watched field differs from the previous snapshot. Nothing here is guessed.
 */
import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState, CountryFlag, PlatformChip } from "@/components/ui";
import { getActivity } from "@/lib/queries";
import { currentWorkspace } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Activity — trysearch" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  release: "Release",
  metadata: "Metadata",
  screenshots: "Screenshots",
  price: "Price",
  category: "Category",
  icon: "Icon",
  rating: "Rating",
};

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ view?: string; scope?: string }> }) {
  const { view = "table", scope = "all" } = await searchParams;
  const ws = await currentWorkspace();
  const { active } = await getActiveApp();
  const events = ws ? await getActivity(ws.id, scope as any, 200) : [];

  return (
    <AppShell current="/activity">
      <PageHeader
        app={active}
        title="Activity"
        subtitle="Changes detected across your tracked apps and competitors"
        actions={
          <div className="flex items-center gap-2">
            {["table", "timeline"].map((v) => (
              <Link
                key={v}
                href={`/activity?view=${v}&scope=${scope}`}
                className={`inline-flex h-8 items-center rounded-[8px] border px-3 text-[12px] capitalize ${
                  view === v
                    ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                    : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                }`}
              >
                {v}
              </Link>
            ))}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        {[
          { id: "all", label: "All" },
          { id: "own", label: "My Apps" },
          { id: "competitor", label: "Competitors" },
        ].map((s) => (
          <Link
            key={s.id}
            href={`/activity?view=${view}&scope=${s.id}`}
            className={`inline-flex h-8 items-center rounded-[8px] border px-2.5 text-[12px] ${
              scope === s.id
                ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
            }`}
          >
            {s.label}
          </Link>
        ))}
      </div>

      <div className="px-6 pb-6">
        {events.length === 0 ? (
          <EmptyState title="No changes detected yet">
            Activity is the diff between consecutive daily snapshots, so it stays empty until something actually changes —
            an empty feed here means nothing moved, not that detection is broken.
          </EmptyState>
        ) : view === "timeline" ? (
          <Panel caption="Newest first, grouped by day.">
            {groupByDay(events).map(([day, dayEvents]) => (
              <section key={day} className="mb-4 last:mb-0">
                <h3 className="th mb-2">{fmt.shortDate(day)}</h3>
                <ol className="relative ml-2 border-l border-[var(--border)] pl-4">
                  {dayEvents.map((e: any) => (
                    <li key={e.id} className="relative pb-4 last:pb-1">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num text-[12px]">{e.app_name}</span>
                        <PlatformChip platform={e.platform} />
                        {e.role === "competitor" && <span className="text-[11px] text-[var(--fg-subtle)]">· Competitor</span>}
                        <Chip>{KIND_LABELS[e.kind] ?? e.kind}</Chip>
                      </div>
                      <Details event={e} />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </Panel>
        ) : (
          <Panel>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th scope="col" className="th px-3 py-2 text-left">App</th>
                    <th scope="col" className="th px-3 py-2 text-left">Details</th>
                    <th scope="col" className="th px-3 py-2 text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e: any) => (
                    <tr key={e.id} className="border-b border-[var(--border)] align-top">
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="flex items-center gap-2.5">
                          {e.icon_url && <img src={e.icon_url} alt="" width={28} height={28} className="rounded-[6px]" />}
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-[var(--fg)]">{e.app_name}</span>
                            <span className="block text-[11px] text-[var(--fg-subtle)]">
                              {e.platform === "ios" ? "iOS" : "Android"}
                              {e.role === "competitor" && (
                                <>
                                  {" · "}
                                  <span className="text-[var(--accent)]">Competitor</span>
                                </>
                              )}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-3"><Details event={e} /></td>
                      <td className="px-3 py-3 whitespace-nowrap text-right text-[var(--fg-subtle)]">
                        {dateLabel(e.occurred_on)}
                        {e.country && <span className="ml-1"><CountryFlag country={e.country} showCode={false} /></span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}

function Details({ event }: { event: any }) {
  if (event.kind === "release") {
    return (
      <div>
        <span className="num text-[12px]">
          {event.old_value ?? "?"} <span className="text-[var(--fg-subtle)]">→</span> {event.new_value ?? "?"}
        </span>
        {event.release_notes && <p className="mt-1 max-w-2xl whitespace-pre-wrap text-[11px] text-[var(--fg-muted)]">{event.release_notes}</p>}
      </div>
    );
  }
  return (
    <div className="max-w-2xl">
      <span className="text-[11px] text-[var(--fg-subtle)]">{event.field}</span>
      <p className="text-[12px] text-[var(--fg-muted)]">
        <span className="line-through opacity-60">{truncate(event.old_value)}</span>{" "}
        <span className="text-[var(--fg-subtle)]">→</span> <span className="text-[var(--fg)]">{truncate(event.new_value)}</span>
      </p>
    </div>
  );
}

const truncate = (s: string | null) => (s == null ? "—" : s.length > 140 ? `${s.slice(0, 137)}…` : s);

/** 'Yesterday' / '5d ago' inside the last week, 'Jul 22' after — matches the reference feed. */
function dateLabel(d: string) {
  const days = (Date.now() - new Date(d).getTime()) / 86_400_000;
  if (days >= 0 && days < 7) {
    const rel = fmt.relativeDate(d);
    return rel.charAt(0).toUpperCase() + rel.slice(1);
  }
  return fmt.shortDate(d);
}

/** Newest-first events → [dayKey, events[]] pairs, preserving order within a day. */
function groupByDay(events: any[]): [string, any[]][] {
  const out: [string, any[]][] = [];
  for (const e of events) {
    const day = String(e.occurred_on).slice(0, 10);
    if (out.length && out[out.length - 1][0] === day) out[out.length - 1][1].push(e);
    else out.push([day, [e]]);
  }
  return out;
}
