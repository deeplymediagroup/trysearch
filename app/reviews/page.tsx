import Link from "next/link";
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { Panel, Chip, EmptyState, CountryFlag, StalenessNote } from "@/components/ui";
import { getReviews, getStaleness, getLatestReviewAnalysis } from "@/lib/queries";
import { classifyReviews } from "@/lib/reviews";
import { analyzeReviews } from "@/app/actions/ai";
import { aiEnabled } from "@/lib/ai";
import { AiButton } from "@/components/AiButton";
import * as fmt from "@/lib/format";

export const metadata = { title: "Reviews — trysearch" };
export const dynamic = "force-dynamic";

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ min?: string; max?: string; sort?: string; analyze?: string }> }) {
  const { min = "1", max = "5", sort = "recent", analyze } = await searchParams;
  const { active } = await getActiveApp();

  if (!active) {
    return (
      <AppShell current="/reviews">
        <PageHeader title="Reviews" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const [reviews, staleness, aiAnalysis] = await Promise.all([
    getReviews(active.app_id, { minRating: Number(min), maxRating: Number(max), sort, limit: 200 }),
    getStaleness(active.app_id),
    getLatestReviewAnalysis(active.app_id),
  ]);

  const analysis = analyze ? classifyReviews(reviews as any) : null;

  return (
    <AppShell current="/reviews">
      <PageHeader
        app={active}
        title="Reviews"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{active.device ?? "iphone"} · {reviews.length} reviews</span>
            <StalenessNote date={staleness} />
          </span>
        }
        actions={
          <span className="flex items-center gap-2">
            {aiEnabled() && (
              <AiButton label="Analyze reviews (AI)" pendingLabel="Reading reviews…" action={analyzeReviews.bind(null, active.app_id)} />
            )}
            <Link
              href={`/reviews?min=${min}&max=${max}&sort=${sort}&analyze=1`}
              className="h-7 rounded-[var(--radius-chip)] border border-[var(--border)] px-2.5 text-[12px] leading-7 text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Quick classify
            </Link>
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-6 py-2.5">
        <span className="th">Rating</span>
        {[1, 2, 3, 4, 5].map((star) => {
          const on = Number(min) <= star && star <= Number(max);
          return (
            <Link
              key={star}
              href={`/reviews?min=${star}&max=${star}&sort=${sort}`}
              className={`rounded-[var(--radius-chip)] border px-2 py-0.5 text-[12px] ${Number(min) === star && Number(max) === star ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--fg-muted)]"}`}
            >
              {star}★
            </Link>
          );
        })}
        <Link href={`/reviews?min=1&max=5&sort=${sort}`} className="rounded-[var(--radius-chip)] border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--fg-muted)]">
          All
        </Link>

        <span className="ml-3 flex items-center gap-1 rounded-[var(--radius-chip)] border border-[var(--border)] p-0.5">
          {[
            { id: "helpful", label: "Most helpful" },
            { id: "recent", label: "Most recent" },
          ].map((s) => (
            <Link
              key={s.id}
              href={`/reviews?min=${min}&max=${max}&sort=${s.id}`}
              className={`rounded-[5px] px-2 py-0.5 text-[12px] ${sort === s.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}
            >
              {s.label}
            </Link>
          ))}
        </span>
      </div>

      <div className="space-y-4 p-6">
        {aiAnalysis && Array.isArray((aiAnalysis as any).changes) && (aiAnalysis as any).changes.length > 0 && (
          <Panel title="Since the previous analysis" caption="Complaint themes compared against the last run.">
            <ul className="grid gap-2 lg:grid-cols-2">
              {((aiAnalysis as any).changes as { theme: string; status: string; detail: string }[]).map((c) => (
                <li key={c.theme} className="text-[12px]">
                  <p className="flex items-center gap-2">
                    <Chip tone={c.status === "resolved" || c.status === "improving" ? "beatable" : c.status === "new" ? "warn" : "neutral"}>{c.status}</Chip>
                    <span className="font-medium">{c.theme}</span>
                  </p>
                  <p className="mt-0.5 text-[var(--fg-muted)]">{c.detail}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {aiAnalysis && (
          <div className="grid gap-3 lg:grid-cols-3">
            {(["praise", "complaints", "feature_requests"] as const).map((group) => (
              <Panel
                key={group}
                title={group === "feature_requests" ? "Feature requests" : group[0].toUpperCase() + group.slice(1)}
                caption={`AI analysis of ${(aiAnalysis as any).review_count} reviews · ${fmt.relativeDate((aiAnalysis as any).created_at)}`}
              >
                {((aiAnalysis as any)[group] ?? []).length === 0 ? (
                  <p className="text-[12px] text-[var(--fg-subtle)]">Nothing found.</p>
                ) : (
                  <ul className="space-y-2">
                    {((aiAnalysis as any)[group] as { theme: string; count: number; quotes: string[] }[]).map((t) => (
                      <li key={t.theme}>
                        <p className="flex items-center justify-between text-[12px]">
                          <span>{t.theme}</span>
                          <span className="num text-[var(--fg-subtle)]">{t.count}</span>
                        </p>
                        {t.quotes[0] && <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--fg-muted)]">“{t.quotes[0]}”</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
        )}

        {analysis && (
          <div className="grid gap-3 lg:grid-cols-3">
            {(["praise", "complaints", "feature_requests"] as const).map((group) => (
              <Panel
                key={group}
                title={group === "feature_requests" ? "Feature requests" : group[0].toUpperCase() + group.slice(1)}
                caption="Local keyword classifier — no API call, no cost."
              >
                {analysis[group].length === 0 ? (
                  <p className="text-[12px] text-[var(--fg-subtle)]">Nothing found in this window.</p>
                ) : (
                  <ul className="space-y-2">
                    {analysis[group].map((t) => (
                      <li key={t.theme}>
                        <p className="flex items-center justify-between text-[12px]">
                          <span className="capitalize">{t.theme.replace(/_/g, " ")}</span>
                          <span className="num text-[var(--fg-subtle)]">{t.count}</span>
                        </p>
                        {t.quotes[0] && <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--fg-muted)]">“{t.quotes[0]}”</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
        )}

        {reviews.length === 0 ? (
          <EmptyState title="No reviews in this filter">
            {Number(min) === 1 && Number(max) === 5
              ? "Run the crawler's reviews job to pull them from the store."
              : "Try a wider rating range."}
          </EmptyState>
        ) : (
          <Panel caption="From the public customer-reviews feed. Each country is its own 500-review pool.">
            <ul className="divide-y divide-[var(--border)]">
              {reviews.map((r: any) => (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-[12px]" style={{ color: r.rating >= 4 ? "var(--up)" : r.rating <= 2 ? "var(--down)" : "var(--warn)" }}>
                      {"★".repeat(r.rating)}
                      <span className="text-[var(--fg-subtle)]">{"★".repeat(5 - r.rating)}</span>
                    </span>
                    <span className="text-[12px] font-medium">{r.title}</span>
                    <CountryFlag country={r.country} />
                    {r.app_version && <Chip>v{r.app_version}</Chip>}
                    <span className="text-[11px] text-[var(--fg-subtle)]">{fmt.relativeDate(r.reviewed_at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] text-[var(--fg-muted)]">{r.body}</p>
                  <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">— {r.author}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
