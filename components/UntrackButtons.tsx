"use client";

/**
 * Untrack an app or a competitor. Destructive, so both spell out the teardown BEFORE doing it.
 *
 * window.confirm rather than a custom modal: it is native, focus-safe, unskippable, and one
 * line of code. A bespoke confirmation dialog would be a component to maintain for no gain.
 */
import { useTransition } from "react";
import { untrackApp } from "@/app/actions/apps";

const BTN =
  "rounded-[var(--radius-chip)] border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:border-[var(--down)] hover:text-[var(--down)] disabled:opacity-50";

export function UntrackAppButton({
  trackedAppId,
  name,
  keywordCount,
  label = "Untrack",
}: {
  trackedAppId: string;
  name: string;
  keywordCount?: number;
  label?: string;
}) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className={BTN}
      onClick={() => {
        const ok = window.confirm(
          `Untrack “${name}”?\n\n` +
            `This removes the app${keywordCount ? `, its ${keywordCount} tracked keyword${keywordCount === 1 ? "" : "s"}` : ""}, ` +
            `its discovered keywords, its competitors and their competitive positions, and its listing drafts.\n\n` +
            `Measured store history (ranks, SERPs, keyword scores) is shared across the workspace and stays — ` +
            `re-adding the app picks it back up.`,
        );
        if (ok) start(() => untrackApp(trackedAppId).then(() => undefined));
      }}
    >
      {pending ? "Removing…" : label}
    </button>
  );
}

export function RemoveCompetitorButton({ trackedAppId, name }: { trackedAppId: string; name: string }) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      className={BTN}
      onClick={() => {
        const ok = window.confirm(
          `Remove “${name}” as a competitor?\n\n` +
            `This drops it out of the competitive buckets and stops its nightly rank checks. ` +
            `It is the last reference to this app, so its tracked data goes with it.\n\n` +
            `The public store measurements it contributed to shared keywords stay.`,
        );
        if (ok) start(() => untrackApp(trackedAppId).then(() => undefined));
      }}
    >
      {pending ? "Removing…" : "Remove"}
    </button>
  );
}
