/**
 * / — the public marketing surface (01-PRODUCT-SPEC.md §17). Own copy, own structure.
 * The console lives behind /dashboard; this page costs nothing to serve.
 */
import Link from "next/link";

export const metadata = {
  title: "trysearch — ASO keyword research & rank tracking on free store data",
  description:
    "Keyword popularity, difficulty, daily rank tracking, competitor gaps, review insights and revenue estimates for the App Store and Google Play — computed from free public store data, with an API and MCP server for AI agents.",
};

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Keyword research that shows its work",
    body: "Popularity and difficulty for every keyword, with the inputs behind each score one click away. Estimates are always marked — a modelled number never impersonates a measured one.",
  },
  {
    title: "Daily rank tracking, 250 deep",
    body: "True ranked search results from the stores themselves, checked nightly across your markets, with brackets, movers, and version releases annotated on every chart.",
  },
  {
    title: "Competitor gap analysis",
    body: "Keyword gaps, winnable-now targets, threats and leads — computed from real SERPs against the competitors you track, with an on-demand AI landscape report.",
  },
  {
    title: "Your AI already knows how to use it",
    body: "A hosted MCP server and REST API put live store data inside Claude Code, Cursor, or any MCP client. Ask which keywords you can actually rank for and get an answer grounded in tonight's crawl.",
  },
  {
    title: "Listing tools that respect the limits",
    body: "A deterministic 100-character keyword-field packer, metadata-safety checks that prevent real App Store rejections, truncation previews, and AI listing drafts that count every grapheme.",
  },
  {
    title: "Reviews, revenue, and your own funnel",
    body: "AI review analysis with verbatim quotes, revenue estimates with confidence labels, and first-party App Store Connect downloads and impressions once you connect a key.",
  },
];

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-14">
        <p className="num mb-3 text-[12px] tracking-wide text-[var(--accent)]">trysearch</p>
        <h1 className="max-w-xl text-[30px] font-semibold leading-tight">
          App Store optimization on data the stores give away for free.
        </h1>
        <p className="mt-4 max-w-xl text-[14.5px] leading-relaxed text-[var(--fg-muted)]">
          Keyword demand, difficulty, daily rankings, competitor gaps, review insights and revenue estimates for iOS and
          Android — every number computed from public store endpoints, every formula published, every estimate labeled.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/dashboard" className="h-9 rounded-[var(--radius-chip)] bg-[var(--accent)] px-4 text-[13px] font-medium leading-9 text-white">
            Open the console
          </Link>
          <Link href="/your-app" className="h-9 rounded-[var(--radius-chip)] border border-[var(--border)] px-4 text-[13px] leading-9 text-[var(--fg-muted)] hover:text-[var(--fg)]">
            Free ASO snapshot — no account
          </Link>
        </div>
      </header>

      <section className="mb-14 grid gap-6 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title}>
            <h2 className="mb-1 text-[14px] font-semibold">{f.title}</h2>
            <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="mb-14 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] p-5">
        <h2 className="mb-2 text-[14px] font-semibold">Connect your AI in one line</h2>
        <pre className="overflow-x-auto rounded-[6px] bg-[var(--bg-elevated)] p-3 text-[12px] leading-relaxed">
{`claude mcp add --transport http trysearch \\
  https://<your-host>/mcp --header "Authorization: Bearer <key>"`}
        </pre>
        <p className="mt-2 text-[12px] text-[var(--fg-muted)]">
          35 tools&apos; worth of capability behind one endpoint: keyword metrics in bulk, listing audits, rank history,
          competitor landscapes, review feeds. The same operations are a plain REST API at <code className="num">/api/v1</code>.
        </p>
      </section>

      <footer className="flex flex-wrap gap-4 border-t border-[var(--border)] pt-6 text-[12px] text-[var(--fg-subtle)]">
        <Link href="/aso-keyword-scores-explained" className="hover:text-[var(--fg)]">How the scores are computed</Link>
        <Link href="/whats-new" className="hover:text-[var(--fg)]">What&apos;s new</Link>
        <Link href="/your-app" className="hover:text-[var(--fg)]">Free snapshot</Link>
        <span className="ml-auto">Free public store data · no paid vendor · $0/month</span>
      </footer>
    </main>
  );
}
