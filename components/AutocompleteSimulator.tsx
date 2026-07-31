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
import { autocompleteProbe, keywordRevealProbe } from "@/app/actions/research";

export function AutocompleteSimulator({ countries, defaultPlatform = "ios" }: { countries: string[]; defaultPlatform?: "ios" | "android" }) {
  const [tab, setTab] = useState<"live" | "reveal">("live");
  const [platform, setPlatform] = useState<"ios" | "android">(defaultPlatform);
  const [country, setCountry] = useState(countries[0] ?? "us");
  const [dark, setDark] = useState(true);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
        <div className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {(["live", "reveal"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={`rounded-[5px] px-2 py-0.5 text-[12px] ${tab === t ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}>
              {t === "live" ? "Live search" : "Keyword reveal"}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {(["ios", "android"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPlatform(p)} aria-pressed={platform === p} className={`rounded-[5px] px-2 py-0.5 text-[12px] ${platform === p ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}>
              {p === "ios" ? "iOS" : "Android"}
            </button>
          ))}
        </div>

        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px] text-[var(--fg-muted)]">
          {[...new Set([...countries, "us", "gb", "de", "jp"])].map((c) => (
            <option key={c} value={c}>{c.toUpperCase()}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[12px] text-[var(--fg-muted)]">
          <input type="checkbox" role="switch" aria-checked={dark} checked={dark} onChange={(e) => setDark(e.target.checked)} />
          Store dark mode
        </label>
      </div>

      <div className="p-6">{tab === "live" ? <LiveSearch platform={platform} country={country} dark={dark} /> : <KeywordReveal platform={platform} country={country} />}</div>
    </div>
  );
}

function LiveSearch({ platform, country, dark }: { platform: "ios" | "android"; country: string; dark: boolean }) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

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
        <Panel title="What you're looking at" caption={source ?? "Type in the phone frame to query the live store."}>
          <p className="text-[12px] text-[var(--fg-muted)]">
            Every keystroke queries the live store autocomplete, then we enrich each suggestion with its cached
            popularity and difficulty. Keystrokes are debounced and each prefix is cached for 6 hours.
          </p>
          <ul className="mt-3 space-y-1 text-[11px] text-[var(--fg-subtle)]">
            <li>· The ORDER is the demand signal — Apple ranks suggestions by search popularity.</li>
            <li>· Apple caps at exactly 10 suggestions; the Play Store's own suggest caps at exactly 5.</li>
            <li>· ( ) means the number is our estimate. — means we have not measured it.</li>
          </ul>
          {loading && <p className="mt-2 text-[11px] text-[var(--accent)]">Querying the store…</p>}
        </Panel>

        {suggestions.length > 0 && (
          <Panel title={`${suggestions.length} suggestions`} caption="Position in this list is itself a demand signal.">
            <ol className="space-y-1">
              {suggestions.map((s, i) => (
                <li key={s.term} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="num truncate">
                    <span className="text-[var(--fg-subtle)]">{i + 1}.</span> {s.term}
                  </span>
                  <span className="num shrink-0 text-[11px] text-[var(--fg-subtle)]">
                    pop {s.popularity_estimate ?? s.popularity ?? "—"} · diff {s.difficulty ?? "—"}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        )}
      </div>
    </div>
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
            className="h-8 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12.5px]"
          />
          <button
            type="button"
            disabled={pending || !term.trim()}
            onClick={() => start(async () => setResult(await keywordRevealProbe(term, platform, country)))}
            className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12px] font-medium text-white disabled:opacity-50"
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
