/**
 * /trends — market-wide keyword niche watch (US iOS).
 *
 * Reads only the latest trend_niches run (written by scripts/trends-job.mjs).
 * Momentum is computed in code from first-seen dates — the AI only names the
 * niches — so the score bar is measured, not modelled.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState, ScoreCell, StalenessNote } from "@/components/ui";
import { q } from "@/lib/db";

export const metadata = { title: "Trends — trysearch" };
export const dynamic = "force-dynamic";

type NicheRow = {
  id: string;
  computed_at: string;
  name: string;
  why_now: string | null;
  momentum: number | null;
  member_terms: string[] | null;
  rising: { term: string; relevance: number | null; first_seen: string }[] | null;
};

async function latestRun(): Promise<NicheRow[]> {
  try {
    return await q<NicheRow>(
      `select id, computed_at, name, why_now, momentum, member_terms, rising
         from trend_niches
        where computed_at = (select max(computed_at) from trend_niches)
        order by momentum desc nulls last, name`,
    );
  } catch {
    // Table not created yet — the job applies its own DDL on first run.
    return [];
  }
}

export default async function TrendsPage() {
  const { active } = await getActiveApp();
  const rows = await latestRun();
  const niches = rows.filter((r) => r.name !== "__rising__");
  const rising = rows.find((r) => r.name === "__rising__")?.rising ?? [];
  const computedAt = rows[0]?.computed_at ?? null;

  if (!rows.length) {
    return (
      <AppShell current="/trends">
        <PageHeader app={active ?? undefined} title="Trends" />
        <div className="p-6">
          <EmptyState title="No trend runs yet">
            The nightly job clusters the last 14 days of US iOS discovered and autocomplete keywords into
            demand niches. Run it once (<code className="num">node scripts/trends-job.mjs</code> — needs{" "}
            <code className="num">ANTHROPIC_API_KEY</code>) and this page fills in.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell current="/trends">
      <PageHeader
        app={active ?? undefined}
        title="Trends"
        subtitle="Market-wide demand niches from the last 14 days of US iOS keyword discovery"
      />

      <div className="grid gap-4 p-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <StalenessNote date={computedAt} label="Trend run as of" />
          {niches.length === 0 ? (
            <EmptyState title="No niches in the latest run">
              The clustering found nothing to group — it needs a few nights of keyword discovery behind it.
            </EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {niches.map((n) => (
                <Panel key={n.id} title={n.name} caption={n.why_now ?? undefined}>
                  <div className="mb-2.5 flex items-center gap-2 text-[12px] text-[var(--fg-muted)]">
                    <span className="th">Momentum</span>
                    <ScoreCell
                      value={n.momentum}
                      label="Momentum"
                      tone={n.momentum != null && n.momentum >= 60 ? "var(--up)" : undefined}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(n.member_terms ?? []).map((t) => (
                      <Chip key={t} tone="neutral">{t}</Chip>
                    ))}
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </div>

        <Panel title="Rising keywords" caption="First seen this week, relevance ≥ 60, brands excluded.">
          {rising.length === 0 ? (
            <p className="text-[12px] text-[var(--fg-muted)]">Nothing new and relevant this week.</p>
          ) : (
            <ul className="space-y-1.5">
              {rising.map((r) => (
                <li key={r.term} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="num min-w-0 truncate">{r.term}</span>
                  <span className="num text-[11px] text-[var(--fg-subtle)]">{r.relevance ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
