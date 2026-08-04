"use client";

/**
 * Both-stores view: one row per (term, country) with independently sortable App Store and
 * Google Play column groups. Only offered when the workspace tracks both platforms.
 */
import { useMemo, useState } from "react";
import { RankPill, ScoreCell, PopularityCell, CountryFlag, EmptyState } from "./ui";
import type { KeywordRow } from "@/lib/queries";

type MergedRow = { term: string; country: string; ios: KeywordRow | null; android: KeywordRow | null };

const SORTS = [
  { id: "term", label: "Keyword" },
  { id: "ios_rank", label: "iOS rank" },
  { id: "android_rank", label: "Android rank" },
] as const;

export function SideBySideTable({ ios, android }: { ios: KeywordRow[]; android: KeywordRow[] }) {
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("term");

  const rows = useMemo(() => {
    const map = new Map<string, MergedRow>();
    const key = (r: KeywordRow) => `${r.term}|${r.country}`;
    for (const r of ios) map.set(key(r), { term: r.term, country: r.country, ios: r, android: null });
    for (const r of android) {
      const existing = map.get(key(r));
      if (existing) existing.android = r;
      else map.set(key(r), { term: r.term, country: r.country, ios: null, android: r });
    }
    const out = [...map.values()];
    const rankOf = (r: KeywordRow | null) => r?.rank ?? 9999;
    if (sort === "ios_rank") out.sort((a, b) => rankOf(a.ios) - rankOf(b.ios));
    else if (sort === "android_rank") out.sort((a, b) => rankOf(a.android) - rankOf(b.android));
    else out.sort((a, b) => a.term.localeCompare(b.term) || a.country.localeCompare(b.country));
    return out;
  }, [ios, android, sort]);

  if (!rows.length) return <div className="p-6"><EmptyState title="No keywords tracked on either store yet" /></div>;

  const storeCells = (r: KeywordRow | null) =>
    r ? (
      <>
        <td className="px-3 py-2"><PopularityCell keyword={r} /></td>
        <td className="px-3 py-2"><ScoreCell value={r.difficulty} parts={r.difficulty_parts} label="Difficulty breakdown" /></td>
        <td className="px-3 py-2"><RankPill state={{ rank: r.rank, found: r.found ?? false, last_known_rank: r.last_known_rank, checked: r.checked_at != null }} /></td>
      </>
    ) : (
      <td colSpan={3} className="px-3 py-2 text-center text-[11px] text-[var(--fg-subtle)]">not tracked</td>
    );

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
        <span className="th">Sort by</span>
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSort(s.id)}
            aria-pressed={sort === s.id}
            className={`rounded-[var(--radius-chip)] px-2 py-0.5 text-[12px] ${sort === s.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th scope="col" rowSpan={2} className="th px-3 py-2 text-left align-bottom">Keyword</th>
              <th scope="col" rowSpan={2} className="th px-3 py-2 text-left align-bottom">Market</th>
              <th scope="colgroup" colSpan={3} className="th border-l border-[var(--border)] px-3 py-1.5 text-left"> App Store</th>
              <th scope="colgroup" colSpan={3} className="th border-l border-[var(--border)] px-3 py-1.5 text-left">▶ Google Play</th>
            </tr>
            <tr className="border-b border-[var(--border)]">
              {["Pop", "Diff", "Rank", "Pop", "Diff", "Rank"].map((h, i) => (
                <th key={i} scope="col" className={`th px-3 py-1.5 text-left ${i % 3 === 0 ? "border-l border-[var(--border)]" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.term}|${r.country}`} className="border-b border-[var(--border)] hover:bg-[var(--sidebar)]">
                <td className="px-3 py-2 text-[14px] font-medium">{r.term}</td>
                <td className="px-3 py-2"><CountryFlag country={r.country} /></td>
                {storeCells(r.ios)}
                {storeCells(r.android)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
