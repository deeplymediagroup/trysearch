"use client";

/**
 * /autocomplete — the Autocomplete Simulator (01-PRODUCT-SPEC.md §11).
 *
 * Two tabs over the SAME underlying probe:
 *   Live search   — every keystroke queries the store's live autocomplete
 *   Keyword reveal — how many characters before your keyword shows up, and where
 *
 * Keystrokes are DEBOUNCED at 250ms and every prefix is cached server-side for 6 hours.
 * Both are required: this is the endpoint most likely to get the whole platform throttled.
 */
import { useState, useEffect, useRef, useTransition } from "react";
import { PhoneFrame, StoreAutocompleteMock } from "./PhoneFrame";
import { Panel, Chip } from "./ui";
import { AiButton } from "./AiButton";
import { autocompleteProbe, keywordRevealProbe, serpProbe, appDetailProbe } from "@/app/actions/research";
import { addSuggestedCompetitor } from "@/app/actions/apps";

export type OwnApp = { tracked_app_id: string; name: string; platform: "ios" | "android" };

export function AutocompleteSimulator({ countries, defaultPlatform = "ios", ownApps = [] }: { countries: string[]; defaultPlatform?: "ios" | "android"; ownApps?: OwnApp[] }) {
  const [tab, setTab] = useState<"live" | "reveal">("live");
  const [platform, setPlatform] = useState<"ios" | "android">(defaultPlatform);
  const [country, setCountry] = useState(countries[0] ?? "us");
  const [dark, setDark] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] px-6">
        {/* Underline tabs on the left, store controls pushed right — reference layout. */}
        <div className="flex items-center gap-4">
          {(["live", "reveal"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={`-mb-px border-b-2 px-0.5 py-2.5 text-[12.5px] ${tab === t ? "border-[var(--fg)] font-medium text-[var(--fg)]" : "border-transparent text-[var(--fg-muted)]"}`}>
              {t === "live" ? "Live search" : "Keyword reveal"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 py-2">
          <div className="flex h-8 items-center gap-0.5 rounded-[8px] border border-[var(--border)] p-0.5">
            {(["ios", "android"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPlatform(p)} aria-pressed={platform === p} className={`h-full rounded-[6px] px-2.5 text-[12px] ${platform === p ? "bg-[var(--bg-hover)] font-medium text-[var(--fg)]" : "text-[var(--fg-muted)]"}`}>
                {p === "ios" ? "iOS" : "Android"}
              </button>
            ))}
          </div>

          <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" className="h-8 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px] text-[var(--fg-muted)]">
            {[...new Set([...countries, "us", "gb", "de", "jp"])].map((c) => (
              <option key={c} value={c}>{c.toUpperCase()}</option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-[12px] text-[var(--fg-muted)]">
            <input type="checkbox" role="switch" aria-checked={dark} checked={dark} onChange={(e) => setDark(e.target.checked)} />
            Store dark mode
          </label>
        </div>
      </div>

      <div className="p-6">{tab === "live" ? <LiveSearch platform={platform} country={country} dark={dark} ownApps={ownApps} /> : <KeywordReveal platform={platform} country={country} />}</div>
    </div>
  );
}

function LiveSearch({ platform, country, dark, ownApps }: { platform: "ios" | "android"; country: string; dark: boolean; ownApps: OwnApp[] }) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [serp, setSerp] = useState<any>(null);
  const [serpLoading, setSerpLoading] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const seq = useRef(0);

  const openSerp = async (term: string) => {
    setSerpLoading(term);
    setDetail(null);
    try {
      setSerp(await serpProbe(term, platform, country));
    } finally {
      setSerpLoading(null);
    }
  };

  const openDetail = async (storeId: string) => {
    setDetailLoading(storeId);
    try {
      setDetail(await appDetailProbe(platform, storeId, country));
    } finally {
      setDetailLoading(null);
    }
  };

  useEffect(() => {
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    // 250ms debounce — without it, every keystroke is an upstream call.
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await autocompleteProbe(value, platform, country);
        // Drop a stale response so fast typing cannot render an out-of-order result.
        if (mine === seq.current) {
          setSuggestions(res.suggestions ?? []);
          setSource(res.source ?? null);
        }
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value, platform, country]);

  return (
    <div className="flex flex-wrap gap-6">
      <PhoneFrame dark={dark} label="Store autocomplete preview">
        <StoreAutocompleteMock dark={dark} value={value} onChange={setValue} suggestions={suggestions} />
      </PhoneFrame>

      <div className="min-w-[280px] flex-1 space-y-3">
        {/* The big query input mirrors the phone's field — type in either. */}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={'Type a query the way a user would — "fit", "sleep so"…'}
          aria-label="Store query"
          className="h-9 w-full rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 text-[12.5px]"
        />

        {suggestions.length === 0 && (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-[var(--border)] px-6 py-10 text-center">
            <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[16px] text-[var(--accent)]">⌕</span>
            <p className="mt-1 text-[13px] font-semibold text-[var(--fg)]">
              {value.trim() ? "No suggestions for this prefix." : "Start typing to see the store's suggestions"}
            </p>
            <p className="max-w-sm text-[12px] text-[var(--fg-muted)]">
              Every keystroke queries the live store autocomplete, then each suggestion is enriched with its cached
              popularity and difficulty. Keystrokes are debounced and each prefix is cached for 6 hours.
            </p>
            <p className="max-w-sm text-[11px] text-[var(--fg-subtle)]">
              The ORDER is the demand signal — Apple caps at 10 suggestions, Play at 5. ( ) means our estimate;
              — means not measured.
            </p>
            {loading && <p className="text-[11px] text-[var(--accent)]">Querying the store…</p>}
          </div>
        )}

        {suggestions.length > 0 && (
          <Panel title={`${suggestions.length} suggestions`} caption={`${source ? `${source} · ` : ""}Position in this list is itself a demand signal. Click one for its live top-10 SERP.`}>
            <ol className="space-y-1">
              {suggestions.map((s, i) => (
                <li key={s.term}>
                  <button
                    type="button"
                    onClick={() => openSerp(s.term)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-[var(--bg-elevated)] ${serp?.term === s.term ? "bg-[var(--accent-soft)]" : ""}`}
                  >
                    <span className="num flex min-w-0 items-center gap-1.5 truncate">
                      <span className="text-[var(--fg-subtle)]">{i + 1}.</span> {s.term}
                      {s.tracked && <Chip tone="branded">Tracked</Chip>}
                    </span>
                    <span className="num shrink-0 text-[11px] text-[var(--fg-subtle)]">
                      {serpLoading === s.term ? "loading…" : <>pop {s.popularity_estimate ?? s.popularity ?? "—"} · diff {s.difficulty ?? "—"}</>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>
        )}

        {serp && !serp.error && (
          <Panel
            title={`Top 10 for “${serp.term}”`}
            caption={`SERP depth ${serp.depth} · pop ${serp.metrics?.popularity_estimate ?? serp.metrics?.popularity ?? "—"} · diff ${serp.metrics?.difficulty ?? "—"} — computed just now and cached. Click an app for its listing.`}
          >
            <ol className="space-y-1">
              {serp.top.map((a: any) => (
                <li key={a.store_id}>
                  <button
                    type="button"
                    onClick={() => openDetail(a.store_id)}
                    className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12px] hover:bg-[var(--bg-elevated)] ${detail?.store_id === a.store_id ? "bg-[var(--accent-soft)]" : ""}`}
                  >
                    <span className="num w-6 shrink-0 text-[var(--fg-subtle)]">#{a.position}</span>
                    {a.icon_url && <img src={a.icon_url} alt="" width={20} height={20} className="rounded-[5px]" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate"><Highlight text={a.name ?? `(app ${a.store_id})`} term={serp.term} /></span>
                      {a.subtitle && <span className="block truncate text-[11px] text-[var(--fg-muted)]"><Highlight text={a.subtitle} term={serp.term} /></span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {a.tracked && <Chip tone="branded">Tracked</Chip>}
                      {a.outlier && <Chip tone="beatable">Outlier</Chip>}
                      <span className="num text-[11px] text-[var(--fg-subtle)]">
                        {detailLoading === a.store_id ? "loading…" : a.rating_count != null ? `★ ${Number(a.rating_average ?? 0).toFixed(1)} · ${Intl.NumberFormat().format(a.rating_count)}` : "—"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>
        )}
        {serp?.error && <Panel title="SERP failed"><p className="text-[12px] text-[var(--down)]">{serp.error}</p></Panel>}

        {detail && !detail.error && (
          <Panel title={detail.name} caption={`${detail.category ?? "—"}${detail.version ? ` · v${detail.version}` : ""}`}>
            <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
              <div><dt className="th">Rating</dt><dd className="num mt-0.5">★ {Number(detail.rating_average ?? 0).toFixed(1)} ({Intl.NumberFormat().format(detail.rating_count ?? 0)})</dd></div>
              <div><dt className="th">Price</dt><dd className="num mt-0.5">{detail.price_cents ? `$${(detail.price_cents / 100).toFixed(2)}` : "Free"}</dd></div>
              <div>
                <dt className="th">IAP range</dt>
                <dd className="num mt-0.5">
                  {detail.iap_range ? `$${(detail.iap_range.min_cents / 100).toFixed(2)}–$${(detail.iap_range.max_cents / 100).toFixed(2)}` : detail.real_installs ? `${Intl.NumberFormat().format(detail.real_installs)} installs` : "—"}
                </dd>
              </div>
              <div>
                <dt className="th">Track</dt>
                <dd className="mt-0.5">
                  {(() => {
                    const own = ownApps.find((o) => o.platform === platform);
                    return own ? (
                      <AiButton
                        label="Track as competitor"
                        pendingLabel="Tracking…"
                        action={addSuggestedCompetitor.bind(null, own.tracked_app_id, platform, detail.store_id)}
                      />
                    ) : (
                      <span className="text-[11px] text-[var(--fg-subtle)]">No own {platform} app</span>
                    );
                  })()}
                </dd>
              </div>
            </dl>
            {detail.description && (
              <p className="mt-3 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--fg-muted)]">
                <Highlight text={detail.description} term={serp?.term ?? value} />
              </p>
            )}
          </Panel>
        )}
        {detail?.error && <Panel title="Lookup failed"><p className="text-[12px] text-[var(--down)]">{detail.error}</p></Panel>}
      </div>
    </div>
  );
}

/** Highlights every word of the probed term inside listing text — where the ranking comes from. */
function Highlight({ text, term }: { text: string; term: string }) {
  const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return <>{text}</>;
  const rx = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  // split with one capture group alternates text/match — odd indices are the matches.
  const parts = text.split(rx);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i} className="rounded-[2px] bg-[var(--accent-soft)] px-0.5 text-[var(--accent)]">{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

function KeywordReveal({ platform, country }: { platform: "ios" | "android"; country: string }) {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<any>(null);
  const [pending, start] = useTransition();

  return (
    <div className="max-w-2xl space-y-3">
      <Panel title="Keyword reveal" caption="Walks prefixes of your keyword one character at a time and reports where it first appears.">
        <div className="flex gap-2">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="e.g. motivational quotes"
            aria-label="Keyword to reveal"
            className="h-9 flex-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-[12.5px]"
          />
          <button
            type="button"
            disabled={pending || !term.trim()}
            onClick={() => start(async () => setResult(await keywordRevealProbe(term, platform, country)))}
            className="h-9 rounded-[10px] bg-[var(--primary)] px-3.5 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {pending ? "Probing…" : "Reveal"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">
          Costs at most 25 autocomplete calls, on Apple&apos;s unthrottled host. An earlier reveal means higher demand:
          a term the store starts suggesting after 3 characters is searched far more than one that needs 13.
        </p>
      </Panel>

      {result && (
        <Panel title={`“${result.term}”`} caption={`${platform === "ios" ? "App Store" : "Google Play"} · ${country.toUpperCase()}`}>
          {result.error ? (
            <p className="text-[12px] text-[var(--down)]">{result.error}</p>
          ) : result.revealed_at_char == null ? (
            <p className="text-[12px] text-[var(--fg-muted)]">
              Never appeared in autocomplete at any prefix length up to 25 characters. That is recorded as{" "}
              <span className="num">null</span>, not zero — we did not observe it, which is different from observing
              that nobody searches it.
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
              <Stat label="Reveals at" value={`${result.revealed_at_char} chars`} />
              <Stat label="Position" value={`#${(result.position ?? 0) + 1} of 10`} />
              <Stat label="Prefixes seen" value={String(result.prefixes_seen)} />
              <Stat label="Popularity" value={result.popularity_estimate == null ? "—" : `(${result.popularity_estimate})`} />
            </dl>
          )}
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="th">{label}</dt>
      <dd className="num mt-0.5 text-[18px]">{value}</dd>
    </div>
  );
}
