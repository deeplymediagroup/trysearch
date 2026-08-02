"use client";

/**
 * One button for every AI action: shows a spinner while the model runs, surfaces the
 * action's error string inline, and refreshes the page so the stored result renders.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AiButton({
  label,
  pendingLabel = "Thinking…",
  action,
}: {
  label: string;
  pendingLabel?: string;
  action: () => Promise<{ ok?: boolean; error?: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await action();
            if (res?.error) setError(res.error);
            else router.refresh();
          })
        }
        className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] leading-7 text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
      >
        {pending ? pendingLabel : label}
      </button>
      {error && <span className="text-[11px] text-[var(--down)]">{error}</span>}
    </span>
  );
}
