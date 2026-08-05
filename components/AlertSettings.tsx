"use client";

/**
 * The eight alert toggles — 01-PRODUCT-SPEC.md §7. ALL DEFAULT OFF.
 *
 * Each row is a real role="switch" with aria-checked, and the rank_drop row exposes both the
 * user's threshold and the effective one.
 */
import { useState, useTransition } from "react";
import { saveAlertSetting, setAlertEmail, pauseAlerts } from "@/app/actions/alerts";

export const ALERT_TYPES = [
  { kind: "rank_drop", title: "Rank drop", description: "A tracked app falls in search results for a keyword.", threshold: true, defaultThreshold: 5 },
  { kind: "out_of_top10", title: "Dropped out of the top 10", description: "An app that was in the top 10 for a keyword falls out." },
  { kind: "new_ranking", title: "New ranking", description: "An app starts ranking for a keyword it didn't before." },
  { kind: "rank_gain", title: "Rank gain", description: "A tracked app climbs in search results for a keyword.", threshold: true, defaultThreshold: 5 },
  { kind: "entered_top10", title: "Entered the top 10", description: "An app breaks into the top 10 for a keyword." },
  { kind: "rating_drop", title: "Rating drop", description: "An app's average rating falls." },
  { kind: "review_spike", title: "Review spike", description: "An app gains an unusual number of new reviews." },
  { kind: "competitor_change", title: "Competitor change", description: "A competitor ships a release, metadata, screenshot, price, or category change." },
] as const;

type Settings = Record<string, { enabled: boolean; threshold: number | null }>;

export function AlertSettings({
  initial,
  email,
  paused,
}: {
  initial: Settings;
  email: string;
  paused: boolean;
}) {
  const [settings, setSettings] = useState<Settings>(initial);
  const [emailValue, setEmailValue] = useState(email);
  const [isPaused, setIsPaused] = useState(paused);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);

  function toggle(kind: string, enabled: boolean) {
    const threshold = settings[kind]?.threshold ?? null;
    setSettings((s) => ({ ...s, [kind]: { enabled, threshold } }));
    start(() => void saveAlertSetting(kind, enabled, threshold));
  }

  function setThreshold(kind: string, raw: string) {
    const threshold = raw === "" ? null : Number(raw);
    const enabled = settings[kind]?.enabled ?? false;
    setSettings((s) => ({ ...s, [kind]: { enabled, threshold } }));
    start(() => void saveAlertSetting(kind, enabled, threshold));
  }

  return (
    <div className="space-y-4">
      <div className="panel divide-y divide-[var(--border)]">
        {ALERT_TYPES.map((a) => {
          const setting = settings[a.kind] ?? { enabled: false, threshold: null };
          const effective = setting.threshold ?? ("defaultThreshold" in a ? a.defaultThreshold : null);
          return (
            <div key={a.kind} className="flex items-start justify-between gap-4 p-3.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{a.title}</p>
                <p className="mt-0.5 text-[11.5px] text-[var(--fg-muted)]">{a.description}</p>
                {"threshold" in a && a.threshold && (
                  <label className="mt-2 flex items-center gap-2 text-[11.5px] text-[var(--fg-subtle)]">
                    Notify when it {a.kind === "rank_drop" ? "drops" : "climbs"} at least
                    <input
                      type="number"
                      min={1}
                      value={setting.threshold ?? ""}
                      placeholder={String(a.defaultThreshold)}
                      onChange={(e) => setThreshold(a.kind, e.target.value)}
                      aria-label={`${a.title} threshold`}
                      className="num w-14 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[var(--fg)]"
                    />
                    ranks
                    {/* Both numbers, deliberately: what you set vs what actually fires. */}
                    <span className="text-[var(--fg-subtle)]">
                      {setting.threshold == null ? `(using the default of ${effective})` : `(effective: ${effective})`}
                    </span>
                  </label>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={setting.enabled}
                aria-label={a.title}
                disabled={pending}
                onClick={() => toggle(a.kind, !setting.enabled)}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${setting.enabled ? "bg-[var(--primary)]" : "bg-[var(--bg-hover)]"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${setting.enabled ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="panel p-3.5">
        <p className="text-[13px] font-medium">Deliver alerts to</p>
        <p className="mt-0.5 text-[11.5px] text-[var(--fg-muted)]">
          By default alerts go to your login email. Set a different address to send them to a shared or team inbox.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="email"
            value={emailValue}
            onChange={(e) => setEmailValue(e.target.value)}
            aria-label="Alert email"
            className="h-8 w-64 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px]"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await setAlertEmail(emailValue);
                setSaved("Saved");
                setTimeout(() => setSaved(null), 2000);
              })
            }
            className="h-8 rounded-[10px] bg-[var(--primary)] px-3 text-[12px] font-medium text-white disabled:opacity-60"
          >
            Save
          </button>
          {saved && <span className="text-[11px] text-[var(--up)]">{saved}</span>}
        </div>
      </div>

      <div className="panel p-3.5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium">Pause alert emails</p>
            <p className="mt-0.5 text-[11.5px] text-[var(--fg-muted)]">Stop the daily digest. Alerts still show up in the feed below.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPaused}
            aria-label="Pause alert emails"
            disabled={pending}
            onClick={() => {
              setIsPaused(!isPaused);
              start(() => void pauseAlerts(!isPaused));
            }}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${isPaused ? "bg-[var(--warn)]" : "bg-[var(--bg-hover)]"}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${isPaused ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </div>
      </div>
    </div>
  );
}
