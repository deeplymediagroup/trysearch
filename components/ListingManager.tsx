"use client";

/**
 * /listing-manager — 01-PRODUCT-SPEC.md §8.
 *
 * The character counters count GRAPHEMES, not UTF-16 code units. That is not pedantry: Apple
 * counts graphemes too, so a code-unit count reports the wrong remaining budget for every
 * Japanese, Korean, Chinese and emoji listing.
 */
import { useState } from "react";
import { PhoneFrame, StoreSearchResultMock } from "./PhoneFrame";
import { Panel, Chip, EmptyState } from "./ui";
import { FIELD_LIMITS } from "@/lib/scoring/listing.mjs";
import { graphemeLength } from "@/lib/scoring/text.mjs";

type Listing = {
  locale: string;
  status: string;
  is_primary: boolean;
  app_name: string | null;
  subtitle: string | null;
  keywords_field: string | null;
  promotional_text: string | null;
  description: string | null;
  release_notes: string | null;
  source: string;
};

const FIELD_ORDER = ["app_name", "subtitle", "keywords_field", "promotional_text", "description", "release_notes"] as const;

export function ListingManager({
  listings,
  screenshots,
  iconUrl,
  targets,
}: {
  listings: Listing[];
  screenshots: string[];
  iconUrl: string | null;
  targets: { slot: number; term: string }[];
}) {
  const live = listings.filter((l) => l.status === "live");
  const drafts = listings.filter((l) => l.status === "draft");
  const [locale, setLocale] = useState(live[0]?.locale ?? listings[0]?.locale ?? "en-US");
  const [dark, setDark] = useState(true);
  const [preview, setPreview] = useState<"search" | "product">("search");
  const [showPreview, setShowPreview] = useState(true);

  const current = listings.find((l) => l.locale === locale) ?? listings[0];

  if (!listings.length) {
    return (
      <div className="p-6">
        <EmptyState title="No listing data yet">
          Run the crawler&apos;s <code className="num">app_snapshot</code> job — it captures the live App Name, Subtitle
          and Description straight from the store. The 100-character Keywords field is never public, so it stays blank
          until you connect App Store Connect.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-4 p-6">
      {/* Localization rail */}
      <aside className="w-[210px] shrink-0 space-y-4">
        <div>
          <p className="th mb-1.5">Live on the store</p>
          <ul className="space-y-1">
            {live.map((l) => (
              <li key={l.locale}>
                <button
                  type="button"
                  onClick={() => setLocale(l.locale)}
                  aria-pressed={locale === l.locale}
                  className={`flex w-full items-center justify-between rounded-[var(--radius-chip)] px-2 py-1.5 text-left text-[12px] ${locale === l.locale ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"}`}
                >
                  <span className="truncate">{localeName(l.locale)}</span>
                  {l.is_primary && <Chip>Primary</Chip>}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-[var(--fg-subtle)]">
            From the public store page. Connect App Store Connect to see every localization you have prepared.
          </p>
        </div>

        <div>
          <p className="th mb-1.5">Drafts · {drafts.length}</p>
          {drafts.length === 0 ? (
            <p className="text-[10px] text-[var(--fg-subtle)]">Not live yet — prepare them here, then publish in App Store Connect.</p>
          ) : (
            <ul className="space-y-1">
              {drafts.map((l) => (
                <li key={l.locale}>
                  <button type="button" onClick={() => setLocale(l.locale)} className="w-full rounded-[var(--radius-chip)] px-2 py-1.5 text-left text-[12px] text-[var(--fg-muted)]">
                    {localeName(l.locale)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Field editor */}
      <div className="min-w-[320px] flex-1 space-y-3">
        <Panel
          title={localeName(locale)}
          caption={`Previewing the ${locale.split("-")[1] ?? "US"} storefront.`}
          action={
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
              <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} />
              Show preview
            </label>
          }
        >
          <div className="rounded-[var(--radius-chip)] border border-[var(--border)] p-2.5">
            <p className="text-[12px] font-medium">Target keywords</p>
            <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
              Pick 3 keywords this localization should rank for — #1 goes in the App Name, #2–3 in the Subtitle — and
              we&apos;ll track them in this market.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[1, 2, 3].map((slot) => {
                const t = targets.find((x) => x.slot === slot);
                return (
                  <span
                    key={slot}
                    className={`rounded-[var(--radius-chip)] border px-2 py-1 text-[11px] ${t ? "border-[var(--accent)] text-[var(--fg)]" : "border-dashed border-[var(--border)] text-[var(--fg-subtle)]"}`}
                  >
                    <span className="num">#{slot}</span> {t ? t.term : slot === 1 ? "→ App Name" : "→ Subtitle"}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {FIELD_ORDER.map((field) => (
              <FieldWithBudget
                key={field}
                field={field}
                value={(current as any)?.[field] ?? ""}
                source={current?.source === "store" ? "Store page" : "App Store Connect"}
              />
            ))}
          </div>
        </Panel>
      </div>

      {/* Store preview */}
      {showPreview && (
        <div className="w-[320px] shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <p className="th flex-1">Store preview</p>
            <div className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
              {(["search", "product"] as const).map((p) => (
                <button key={p} type="button" onClick={() => setPreview(p)} aria-pressed={preview === p} className={`rounded-[4px] px-1.5 py-0.5 text-[11px] ${preview === p ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}>
                  {p === "search" ? "Search results" : "Product page"}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <input type="checkbox" role="switch" aria-checked={dark} checked={dark} onChange={(e) => setDark(e.target.checked)} />
            Store dark mode
          </label>

          <PhoneFrame dark={dark} label="App Store search result preview">
            <StoreSearchResultMock
              dark={dark}
              appName={current?.app_name ?? ""}
              subtitle={current?.subtitle ?? ""}
              iconUrl={iconUrl}
              screenshots={preview === "search" ? screenshots.slice(0, 3) : screenshots}
            />
          </PhoneFrame>

          <p className="text-[10px] leading-relaxed text-[var(--fg-subtle)]">
            One line each for App Name and Subtitle, plus your first three screenshots — the placement that wins or
            loses the tap. These mock fonts only approximate the store&apos;s, so a borderline cut is genuinely
            borderline.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * FieldWithBudget — label, source badge, `used/limit` counter, an indexed badge, and a
 * warning as the limit approaches.
 */
function FieldWithBudget({ field, value, source }: { field: keyof typeof FIELD_LIMITS; value: string; source: string }) {
  const [text, setText] = useState(value);
  const meta = FIELD_LIMITS[field];
  // Graphemes, not code units — "👨‍👩‍👧" is one character to Apple and 11 to String.length.
  const used = graphemeLength(text);
  const ratio = used / meta.limit;
  const over = used > meta.limit;
  const near = ratio > 0.9;
  const long = meta.limit > 200;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <label htmlFor={`f-${field}`} className="text-[12px] font-medium">{meta.label}</label>
        <Chip tone={meta.indexed ? "beatable" : "neutral"} title={meta.indexed ? "Store search indexes this field." : "Not indexed by store search — it converts, it does not rank."}>
          {meta.indexed ? "indexed" : "not indexed"}
        </Chip>
        <span className="text-[10px] text-[var(--fg-subtle)]">{source}</span>
        <span className={`num ml-auto text-[11px] ${over ? "text-[var(--down)]" : near ? "text-[var(--warn)]" : "text-[var(--fg-subtle)]"}`}>
          {used}/{meta.limit}
        </span>
      </div>
      {long ? (
        <details>
          <summary className="cursor-pointer text-[11px] text-[var(--fg-subtle)]">Show more</summary>
          <textarea
            id={`f-${field}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            className="mt-1 w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2 text-[12px]"
          />
        </details>
      ) : (
        <input
          id={`f-${field}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`w-full rounded-[var(--radius-chip)] border bg-[var(--bg-elevated)] px-2 py-1.5 text-[12.5px] ${over ? "border-[var(--down)]" : "border-[var(--border)]"}`}
        />
      )}
      {field === "keywords_field" && !text && (
        <p className="mt-1 text-[10px] text-[var(--fg-subtle)]">
          The 100-character keyword field is never public — no free endpoint exposes it. Connect App Store Connect, or
          paste yours here to check coverage.
        </p>
      )}
      {over && <p className="mt-1 text-[10px] text-[var(--down)]">{used - meta.limit} character(s) over the limit — the store will reject this.</p>}
    </div>
  );
}

const LOCALE_NAMES: Record<string, string> = {
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "en-CA": "English (Canada)",
  "en-AU": "English (Australia)",
  "de-DE": "German (Germany)",
  "fr-FR": "French (France)",
  "it-IT": "Italian",
  "ja-JP": "Japanese",
  "es-ES": "Spanish (Spain)",
};

function localeName(locale: string) {
  return LOCALE_NAMES[locale] ?? locale;
}
