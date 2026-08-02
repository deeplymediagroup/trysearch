"use client";

/**
 * "Size up any app" box on /revenue — paste anything, get an estimate without tracking it.
 *
 * The result renders its own factors list rather than hiding it behind a tooltip: an estimate
 * built from a modelled install count is only usable if you can see that's what it is.
 */
import { useState, useTransition } from "react";
import { lookupRevenue, type RevenueLookup as Result } from "@/app/actions/revenue";
import { Chip } from "./ui";

const CONFIDENCE_TONE: Record<string, "beatable" | "warn" | "neutral"> = {
  high: "beatable",
  medium: "warn",
  low: "neutral",
};

export function RevenueLookup() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function go() {
    if (!input.trim()) return;
    setError(null);
    start(async () => {
      const res = await lookupRevenue(input);
      setResult(res.result ?? null);
      setError(res.error ?? null);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          placeholder="Any app — name, store link, id or package name"
          aria-label="App to estimate"
          className="min-w-[280px] flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[12.5px]"
        />
        <button
          type="button"
          onClick={go}
          disabled={pending || !input.trim()}
          className="h-8 rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {pending ? "Estimating…" : "Estimate"}
        </button>
      </div>

      {error && <p className="text-[12px] text-[var(--warn)]">{error}</p>}

      {result && (
        <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold">{result.name}</span>
            <Chip tone="neutral">{result.store === "ios" ? "App Store" : "Google Play"}</Chip>
            <Chip tone="neutral">{result.model.replace("_", " ")}</Chip>
            <Chip tone={CONFIDENCE_TONE[result.confidence] ?? "neutral"} title="How much to trust this number">
              {result.confidence} confidence
            </Chip>
            <span className="num ml-auto text-[18px] font-semibold">{result.display}</span>
          </div>

          {result.monthly_usd_low != null && result.monthly_usd_high != null && (
            <p className="num mt-1 text-[11px] text-[var(--fg-subtle)]">
              modelled range ${result.monthly_usd_low.toLocaleString()} – ${result.monthly_usd_high.toLocaleString()}/mo
            </p>
          )}

          <p className="th mt-3 mb-1">How this was derived</p>
          <ul className="space-y-1">
            {result.factors.map((f) => (
              <li key={f} className="text-[11.5px] leading-relaxed text-[var(--fg-muted)]">
                · {f}
              </li>
            ))}
          </ul>

          {result.iaps.length > 0 && (
            <>
              <p className="th mt-3 mb-1">Real in-app prices scraped ({result.iaps.length})</p>
              <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {result.iaps.slice(0, 8).map((i) => (
                  <li key={i.name} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                    <span className="truncate text-[var(--fg-muted)]">{i.name}</span>
                    <span className="num whitespace-nowrap">
                      ${(i.price_cents / 100).toFixed(2)}
                      {i.period ? <span className="text-[var(--fg-subtle)]">/{i.period}</span> : null}
                      {i.annualised_cents ? (
                        <span className="text-[10px] text-[var(--fg-subtle)]"> (${Math.round(i.annualised_cents / 100)}/yr)</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
