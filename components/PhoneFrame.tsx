"use client";

/**
 * Store mockups — 06-FRONTEND-SPEC.md §3.5. Used by Listing Manager and the Autocomplete
 * Simulator.
 *
 * These deliberately ship an honesty caption: mock fonts are not the store's font, so a
 * borderline truncation is genuinely borderline. Claiming pixel accuracy we do not have
 * would be worse than showing an approximation and saying so.
 */
import { truncationPoint } from "@/lib/scoring/listing.mjs";

export function PhoneFrame({ dark, children, label }: { dark: boolean; children: React.ReactNode; label?: string }) {
  return (
    <div
      className="w-[300px] shrink-0 overflow-hidden rounded-[26px] border-[6px] shadow-xl"
      style={{ borderColor: "#26262b", background: dark ? "#000" : "#fff" }}
      role="img"
      aria-label={label ?? "Store preview"}
    >
      <div className="flex items-center justify-between px-4 pb-1 pt-2 text-[11px] font-semibold" style={{ color: dark ? "#fff" : "#000" }}>
        <span className="num">9:41</span>
        <span className="flex items-center gap-1 text-[9px]">▮▮▮ ▾ ▰</span>
      </div>
      {children}
    </div>
  );
}

/**
 * StoreSearchResultMock — the placement that wins or loses the tap: one line each for App
 * Name and Subtitle, plus the first three screenshots.
 */
export function StoreSearchResultMock({
  dark,
  appName,
  subtitle,
  iconUrl,
  screenshots = [],
}: {
  dark: boolean;
  appName: string;
  subtitle: string;
  iconUrl?: string | null;
  screenshots?: string[];
}) {
  const fg = dark ? "#fff" : "#000";
  const muted = dark ? "#8e8e93" : "#8a8a8e";

  const nameCut = truncationPoint(appName, "search_result");
  const subCut = truncationPoint(subtitle, "search_result");

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center gap-2.5 py-2">
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={iconUrl} alt="" width={54} height={54} className="rounded-[12px]" />
        ) : (
          <div className="h-[54px] w-[54px] rounded-[12px]" style={{ background: dark ? "#1c1c1e" : "#e5e5ea" }} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold" style={{ color: fg }}>{appName || "App Name"}</p>
          <p className="truncate text-[11px]" style={{ color: muted }}>{subtitle || "Subtitle"}</p>
        </div>
        <span className="rounded-full px-3.5 py-1 text-[12px] font-semibold" style={{ background: dark ? "#1c1c1e" : "#e8e8ed", color: "#0a84ff" }}>
          GET
        </span>
      </div>

      <div className="flex gap-1.5 overflow-hidden">
        {[0, 1, 2].map((i) =>
          screenshots[i] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={screenshots[i]} alt="" className="h-[150px] w-[84px] shrink-0 rounded-[8px] object-cover" />
          ) : (
            <div key={i} className="h-[150px] w-[84px] shrink-0 rounded-[8px]" style={{ background: dark ? "#1c1c1e" : "#f2f2f7" }} />
          ),
        )}
      </div>

      {(nameCut.truncated || subCut.truncated) && (
        <p className="mt-2 rounded-[6px] px-2 py-1.5 text-[10px] leading-snug" style={{ background: "rgba(245,158,11,0.14)", color: "#f59e0b" }}>
          Cut off here: {[nameCut.truncated && "App Name", subCut.truncated && "Subtitle"].filter(Boolean).join(" and ")}. The
          words past the cut still get indexed, but nobody reads them in this placement.
        </p>
      )}
      {!screenshots.length && (
        <p className="mt-2 text-[10px]" style={{ color: muted }}>
          No screenshots found for this storefront — the tiles show empty slots.
        </p>
      )}
    </div>
  );
}

/** StoreAutocompleteMock — the search field and the live suggestion list. */
export function StoreAutocompleteMock({
  dark,
  value,
  onChange,
  suggestions,
  placeholder = "Games, Apps, Stories, and More",
}: {
  dark: boolean;
  value: string;
  onChange: (v: string) => void;
  suggestions: { term: string; popularity: number | null; popularity_estimate: number | null; difficulty: number | null }[];
  placeholder?: string;
}) {
  const fg = dark ? "#fff" : "#000";
  const muted = dark ? "#8e8e93" : "#8a8a8e";

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center gap-2 py-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-[10px] px-2 py-1.5" style={{ background: dark ? "#1c1c1e" : "#e8e8ed" }}>
          <span style={{ color: muted }} className="text-[12px]">⌕</span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label="Store search"
            className="w-full bg-transparent text-[13px] outline-none"
            style={{ color: fg }}
          />
        </div>
        <span className="text-[13px]" style={{ color: "#0a84ff" }}>Cancel</span>
      </div>

      <ul className="min-h-[220px]">
        {suggestions.length === 0 ? (
          <li className="py-6 text-center text-[11px]" style={{ color: muted }}>
            {value ? "No suggestions for this prefix." : "Start typing to see the store's suggestions."}
          </li>
        ) : (
          suggestions.map((s, i) => (
            <li key={`${s.term}-${i}`} className="flex items-center justify-between gap-2 border-b py-2" style={{ borderColor: dark ? "#1c1c1e" : "#f2f2f7" }}>
              <span className="flex min-w-0 items-center gap-2">
                <span style={{ color: muted }} className="text-[11px]">⌕</span>
                <span className="truncate text-[12.5px]" style={{ color: fg }}>{s.term}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[10px]" style={{ color: muted }}>
                {/* Parentheses mean the number is ours, not the store's. */}
                <span className="num">
                  {s.popularity != null
                    ? s.popularity_estimate != null && s.popularity_estimate !== s.popularity
                      ? `${s.popularity} (${s.popularity_estimate})`
                      : s.popularity
                    : s.popularity_estimate != null
                      ? `(${s.popularity_estimate})`
                      : "—"}
                </span>
                <span>·</span>
                <span className="num">{s.difficulty ?? "—"}</span>
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
