"use client";

/**
 * The two dialogs that make the console self-service: Add App (also used for Add Competitor
 * and for linking the other store's version) and Add Keywords.
 *
 * Built on the native <dialog> element — it brings the modal backdrop, Esc-to-close, focus
 * trapping and inert-background for free. A hand-rolled modal is a component to maintain and
 * an accessibility bug waiting to happen.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { STOREFRONTS, ENGLISH_FIRST, COUNTRY_NAMES, flagEmoji } from "@/lib/stores/storefronts.mjs";
import { findApp, trackApp, type Candidate } from "@/app/actions/apps";
import { addKeywords } from "@/app/actions/keywords";

const COUNTRIES: string[] = [...ENGLISH_FIRST, ...Object.keys(STOREFRONTS).filter((c) => !ENGLISH_FIRST.includes(c))];

const BTN_PRIMARY =
  "h-7 rounded-[var(--radius-chip)] bg-[var(--accent)] px-2.5 text-[12px] font-medium leading-7 text-white disabled:opacity-50";
const BTN_QUIET =
  "h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] leading-7 text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50";
const FIELD =
  "w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[12.5px] text-[var(--fg)]";

/** A <dialog> plus its trigger. `children` receives the closer so a success can dismiss it. */
function Modal({
  trigger,
  triggerClass = BTN_PRIMARY,
  title,
  caption,
  children,
}: {
  trigger: React.ReactNode;
  triggerClass?: string;
  title: string;
  caption?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // `open` is the single source of truth and the element is synced to it, so nothing reads the
  // ref during render and Esc-to-close (which fires onClose) stays in step with React.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        className="w-[min(560px,92vw)] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-0 text-[var(--fg)] backdrop:bg-black/50"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold">{title}</h2>
            {caption && <p className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">{caption}</p>}
          </div>
          <button type="button" onClick={close} aria-label="Close" className="text-[13px] text-[var(--fg-subtle)] hover:text-[var(--fg)]">
            ✕
          </button>
        </div>
        {/* Mount the body only while open so each opening starts from a clean state. */}
        <div className="p-4">{open && children(close)}</div>
      </dialog>
    </>
  );
}

function CountryPicker({
  value,
  onChange,
  label = "Storefront",
}: {
  value: string;
  onChange: (c: string) => void;
  label?: string;
}) {
  return (
    <label className="block">
      <span className="th mb-1 block">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
        {COUNTRIES.map((c) => (
          <option key={c} value={c}>
            {flagEmoji(c)} {COUNTRY_NAMES[c] ?? c.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Add App / Add Competitor / link the other store's version. All three are the same job:
 * resolve a paste to a real store listing, then insert one tracked_apps row.
 */
export function AddAppDialog({
  role = "own",
  competitorOf = null,
  label = "+ Add app",
  triggerClass,
}: {
  role?: "own" | "competitor";
  competitorOf?: string | null;
  label?: string;
  triggerClass?: string;
}) {
  return (
    <Modal
      trigger={label}
      triggerClass={triggerClass}
      title={role === "competitor" ? "Add a competitor" : "Add an app"}
      caption="Paste a store link, a numeric App Store id, a bundle id or package name, or just the app's name."
    >
      {(close) => <AddAppBody role={role} competitorOf={competitorOf} close={close} />}
    </Modal>
  );
}

function AddAppBody({ role, competitorOf, close }: { role: "own" | "competitor"; competitorOf: string | null; close: () => void }) {
  const [input, setInput] = useState("");
  const [store, setStore] = useState<"both" | "ios" | "android">("both");
  const [country, setCountry] = useState("us");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function search() {
    if (!input.trim()) return;
    setMessage(null);
    start(async () => {
      const res = await findApp(input, { store: store === "both" ? null : store, country });
      setCandidates(res.candidates);
      if (res.error) setMessage(res.error);
      else if (!res.candidates.length) setMessage("Nothing matched. Try the store link instead of the name.");
    });
  }

  function pick(c: Candidate) {
    setMessage(null);
    start(async () => {
      try {
        const res = await trackApp({ store: c.store, storeId: c.store_id, country: c.country, role, competitorOf });
        setMessage(`Tracking ${res.name}.`);
        setCandidates(null);
        close();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-3">
      <input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search();
          }
        }}
        placeholder="https://apps.apple.com/us/app/…/id1487761500"
        className={FIELD}
        aria-label="App link, id or name"
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="th mb-1 block">Store</span>
          <select value={store} onChange={(e) => setStore(e.target.value as "both" | "ios" | "android")} className={FIELD}>
            <option value="both">Both stores</option>
            <option value="ios">App Store</option>
            <option value="android">Google Play</option>
          </select>
        </label>
        <CountryPicker value={country} onChange={setCountry} />
        <button type="button" onClick={search} disabled={pending || !input.trim()} className={BTN_QUIET}>
          {pending ? "Looking…" : "Find"}
        </button>
      </div>

      {message && <p className="text-[12px] text-[var(--warn)]">{message}</p>}

      {candidates && candidates.length > 0 && (
        <ul className="max-h-64 divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius-chip)] border border-[var(--border)]">
          {candidates.map((c) => (
            <li key={`${c.store}-${c.store_id}`}>
              <button
                type="button"
                disabled={pending}
                onClick={() => pick(c)}
                className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {c.icon_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon_url} alt="" width={26} height={26} className="h-[26px] w-[26px] shrink-0 rounded-[7px]" />
                ) : (
                  <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-[var(--bg-hover)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{c.name}</span>
                  <span className="block truncate text-[11px] text-[var(--fg-subtle)]">
                    {c.developer_name ?? "unknown developer"} · {c.store === "ios" ? "App Store" : "Google Play"} · <span className="num">{c.store_id}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Add Keywords — one term per line, tracked across every checked storefront. The action is
 * idempotent, so re-pasting a list you already added reports "already tracked" rather than
 * duplicating anything.
 */
export function AddKeywordsDialog({
  trackedAppId,
  countries,
  label = "+ Add Keywords",
  triggerClass,
}: {
  trackedAppId: string;
  countries: string[];
  label?: string;
  triggerClass?: string;
}) {
  return (
    <Modal trigger={label} triggerClass={triggerClass} title="Add keywords" caption="One keyword per line. Each one is tracked separately per storefront.">
      {() => <AddKeywordsBody trackedAppId={trackedAppId} countries={countries} />}
    </Modal>
  );
}

function AddKeywordsBody({ trackedAppId, countries }: { trackedAppId: string; countries: string[] }) {
  // Offer the storefronts this app is already tracked in, plus the English-first defaults.
  const options = [...new Set([...countries, ...ENGLISH_FIRST])];
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(countries.length ? countries : ["us"]));
  const [result, setResult] = useState<{ added: number; alreadyTracked: number; failed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const terms = text.split("\n").map((t) => t.trim()).filter(Boolean);

  function submit() {
    if (!terms.length || !picked.size) return;
    setError(null);
    start(async () => {
      try {
        setResult(await addKeywords(trackedAppId, terms, [...picked]));
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-3">
      <textarea
        autoFocus
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"motivation\nmorning routine\ndiscipline quotes"}
        className={`${FIELD} num resize-y`}
        aria-label="Keywords, one per line"
      />

      <div>
        <span className="th mb-1 block">Storefronts</span>
        <div className="flex flex-wrap gap-2">
          {options.map((c) => (
            <label key={c} className="flex items-center gap-1.5 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 py-1 text-[12px]">
              <input
                type="checkbox"
                checked={picked.has(c)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(c);
                    else next.delete(c);
                    return next;
                  })
                }
              />
              <span aria-hidden>{flagEmoji(c)}</span>
              <span className="num">{c.toUpperCase()}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={submit} disabled={pending || !terms.length || !picked.size} className={BTN_PRIMARY}>
          {pending ? "Adding…" : `Add ${terms.length || ""} keyword${terms.length === 1 ? "" : "s"}`.trim()}
        </button>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {terms.length} term{terms.length === 1 ? "" : "s"} × {picked.size} storefront{picked.size === 1 ? "" : "s"}
        </span>
      </div>

      {error && <p className="text-[12px] text-[var(--warn)]">{error}</p>}
      {result && (
        <p className="text-[12px] text-[var(--fg-muted)]">
          <span className="num">{result.added}</span> added
          {result.alreadyTracked ? <> · <span className="num">{result.alreadyTracked}</span> already tracked</> : null}
          {result.failed.length ? <> · <span className="num">{result.failed.length}</span> rejected</> : null}
          . Popularity and difficulty are computing now — refresh in about a minute. Rank fills in on the nightly SERP pass.
        </p>
      )}
    </div>
  );
}
