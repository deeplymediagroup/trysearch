"use client";

/**
 * /research — standalone keyword research (Workstream J). One client component drives the
 * whole loop: create project → seed/add keywords → metrics fill in (on-demand pass) →
 * cherry-pick → push to a tracked app.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Panel, Chip, EmptyState, PopularityCell, ScoreCell, CountryFlag } from "./ui";
import { createResearchProject, deleteResearchProject, addResearchKeywords, seedFromApp, pushToApp } from "@/app/actions/projects";
import type { OwnApp } from "./AutocompleteSimulator";

type Project = { id: string; name: string; created_at: string; keyword_count: number };
type Row = { id: string; term: string; platform: string; country: string; popularity: number | null; popularity_estimate: number | null; difficulty: number | null; metrics_updated_at: string | null };

export function ResearchView({ projects, selected, rows, ownApps }: { projects: Project[]; selected: Project | null; rows: Row[]; ownApps: OwnApp[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [terms, setTerms] = useState("");
  const [stores, setStores] = useState<Set<"ios" | "android">>(new Set(["ios"]));
  const [countries, setCountries] = useState("us");
  const [seedStore, setSeedStore] = useState<"ios" | "android">("ios");
  const [seedId, setSeedId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pushTarget, setPushTarget] = useState(ownApps[0]?.tracked_app_id ?? "");

  const run = (fn: () => Promise<{ error?: string; [k: string]: unknown } | void>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (res && "error" in res && res.error) setError(res.error);
      else router.refresh();
    });

  const toggleStore = (s: "ios" | "android") =>
    setStores((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next.size ? next : prev; // never empty
    });

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickedRows = rows.filter((r) => picked.has(r.id));

  return (
    <div className="grid gap-4 p-6 lg:grid-cols-[240px_1fr]">
      <div className="space-y-3">
        <Panel title="Projects">
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project name"
              aria-label="New project name"
              className="h-7 min-w-0 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px]"
            />
            <button
              type="button"
              disabled={pending || !name.trim()}
              onClick={() => run(async () => { const r = await createResearchProject(name); if (!r.error) setName(""); return r; })}
              className="h-7 shrink-0 rounded-[var(--radius-chip)] bg-[var(--accent)] px-2 text-[12px] font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </div>
          <ul className="mt-2 space-y-0.5">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-1">
                <Link
                  href={`/research?id=${p.id}`}
                  className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[12.5px] ${selected?.id === p.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
                >
                  {p.name} <span className="num text-[11px] text-[var(--fg-subtle)]">{p.keyword_count}</span>
                </Link>
                <button
                  type="button"
                  title="Delete project (keywords and their metrics survive)"
                  onClick={() => run(() => deleteResearchProject(p.id))}
                  className="shrink-0 rounded px-1 text-[12px] text-[var(--fg-subtle)] hover:text-[var(--down)]"
                >
                  ✕
                </button>
              </li>
            ))}
            {projects.length === 0 && <li className="text-[11.5px] text-[var(--fg-subtle)]">No projects yet.</li>}
          </ul>
        </Panel>
      </div>

      <div className="space-y-3">
        {error && <p className="text-[12px] text-[var(--down)]">{error}</p>}

        {!selected ? (
          <Panel>
            <EmptyState title="Pick or create a project">
              Research projects size a niche end-to-end — seed from an app or paste keywords, let popularity and
              difficulty compute, then push the winners to a tracked app — without creating a fake tracked app.
            </EmptyState>
          </Panel>
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <Panel title="Add keywords" caption="One per line. Metrics compute on the spot (~30s) and cache for everyone.">
                <textarea
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  rows={3}
                  placeholder={"meditation for sleep\nanxiety relief"}
                  aria-label="Keywords, one per line"
                  className="w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2 text-[12px]"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(["ios", "android"] as const).map((s) => (
                    <label key={s} className="flex items-center gap-1 text-[12px] text-[var(--fg-muted)]">
                      <input type="checkbox" checked={stores.has(s)} onChange={() => toggleStore(s)} /> {s === "ios" ? "iOS" : "Android"}
                    </label>
                  ))}
                  <input
                    value={countries}
                    onChange={(e) => setCountries(e.target.value)}
                    aria-label="Countries, comma-separated"
                    className="h-7 w-24 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px]"
                  />
                  <button
                    type="button"
                    disabled={pending || !terms.trim()}
                    onClick={() =>
                      run(async () => {
                        const r = await addResearchKeywords(
                          selected.id,
                          terms.split("\n"),
                          [...stores],
                          countries.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
                        );
                        if (!r.error) setTerms("");
                        return r;
                      })
                    }
                    className="h-7 rounded-[var(--radius-chip)] bg-[var(--accent)] px-2.5 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    {pending ? "Adding…" : "Add"}
                  </button>
                </div>
              </Panel>

              <Panel title="Seed from an app" caption="Its keywords ranked in our SERP corpus, plus its listing terms.">
                <div className="flex flex-wrap items-center gap-2">
                  <select value={seedStore} onChange={(e) => setSeedStore(e.target.value as any)} aria-label="Seed store" className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px]">
                    <option value="ios">iOS</option>
                    <option value="android">Android</option>
                  </select>
                  <input
                    value={seedId}
                    onChange={(e) => setSeedId(e.target.value)}
                    placeholder={seedStore === "ios" ? "Numeric app id" : "Package name"}
                    aria-label="App id to seed from"
                    className="h-7 min-w-0 flex-1 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px]"
                  />
                  <button
                    type="button"
                    disabled={pending || !seedId.trim()}
                    onClick={() => run(async () => { const r = await seedFromApp(selected.id, seedStore, seedId.trim(), countries.split(",")[0]?.trim() || "us"); if (!r.error) setSeedId(""); return r; })}
                    className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-50"
                  >
                    {pending ? "Seeding…" : "Seed"}
                  </button>
                </div>
              </Panel>
            </div>

            <Panel
              title={`${selected.name} — ${rows.length} keywords`}
              caption="Tick the winners, then push them to a tracked app. Pushing tracks them in the countries picked above."
            >
              {rows.length === 0 ? (
                <EmptyState title="Empty project">Seed it from an app or paste keywords.</EmptyState>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-[12px] text-[var(--fg-muted)]">
                      <input
                        type="checkbox"
                        checked={picked.size === rows.length && rows.length > 0}
                        onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                      All
                    </label>
                    <span className="num text-[12px] text-[var(--fg-subtle)]">{picked.size} selected</span>
                    <select value={pushTarget} onChange={(e) => setPushTarget(e.target.value)} aria-label="Push target app" className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 text-[12px]">
                      {ownApps.map((a) => (
                        <option key={a.tracked_app_id} value={a.tracked_app_id}>{a.name} ({a.platform})</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={pending || !picked.size || !pushTarget}
                      onClick={() =>
                        run(() =>
                          pushToApp(
                            pushTarget,
                            [...new Set(pickedRows.map((r) => r.term))],
                            [...new Set(pickedRows.map((r) => r.country))],
                          ),
                        )
                      }
                      className="h-7 rounded-[var(--radius-chip)] bg-[var(--accent)] px-2.5 text-[12px] font-medium text-white disabled:opacity-50"
                    >
                      {pending ? "Pushing…" : `Add to app (${picked.size})`}
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12.5px]">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          {["", "Keyword", "Store", "Market", "Popularity", "Difficulty", "Scored"].map((h, i) => (
                            <th key={i} scope="col" className="th px-3 py-2 text-left whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id} className="border-b border-[var(--border)]">
                            <td className="px-3 py-1.5"><input type="checkbox" aria-label={`Select ${r.term}`} checked={picked.has(r.id)} onChange={() => togglePick(r.id)} /></td>
                            <td className="num px-3 py-1.5">{r.term}</td>
                            <td className="px-3 py-1.5"><Chip>{r.platform === "ios" ? "iOS" : "Android"}</Chip></td>
                            <td className="px-3 py-1.5"><CountryFlag country={r.country} /></td>
                            <td className="px-3 py-1.5"><PopularityCell keyword={r} /></td>
                            <td className="px-3 py-1.5"><ScoreCell value={r.difficulty} label="Difficulty" /></td>
                            <td className="px-3 py-1.5 text-[11px] text-[var(--fg-subtle)]">{r.metrics_updated_at ? "✓" : "calculating…"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
