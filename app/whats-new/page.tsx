/**
 * /whats-new — the public changelog (01-PRODUCT-SPEC.md §0.1, §17).
 * ponytail: a static array. It becomes a table the day someone else needs to edit it.
 */
import Link from "next/link";

export const metadata = { title: "What's New — trysearch" };

const ENTRIES: { date: string; title: string; items: string[] }[] = [
  {
    date: "2026-08-03",
    title: "Smarter discovery",
    items: [
      "AI relevance scoring — every discovered keyword now carries a 0–100 intent-match score with a one-line reason (hover the Relevance column). Opportunity ranking uses it.",
      "AI keyword generation — the nightly discovery run reads your listing and your competitors' and proposes intent phrases, niches and competitor-derivative queries; only candidates confirmed by live autocomplete are kept.",
      "Chart discovery — top-chart apps in your category feed their keyword-indexed subtitles into discovery, gated by the relevance pass.",
      "Competitive analyses now diff themselves against the previous run (\"What changed\"), and each opportunity cluster has a one-click Track all.",
    ],
  },
  {
    date: "2026-07-31",
    title: "AI, API & MCP release",
    items: [
      "MCP server at /mcp — connect Claude Code or any MCP client and research keywords, rankings, competitors and reviews with live store data.",
      "REST API at /api/v1 — stateless research endpoints (app lookup, search, ASO score, keyword metrics, autocomplete) plus workspace reads, Bearer-token auth.",
      "AI review analysis — praise / complaints / feature requests with verbatim quotes, stored so past reports stay readable.",
      "AI competitive analyses — posture, opportunities, threats and strengths grounded in your tracked keywords (one per app per 7 days).",
      "AI listing generation — App Name, Subtitle, Promotional Text and Description drafts that respect every character limit; the keyword field still comes from the deterministic packer.",
      "Performance & Engagement pages — first-party App Store Connect downloads, proceeds and the impressions funnel (connect prompt until credentials are added).",
      "Free ASO snapshot at /your-app — score any public app's listing with no account.",
    ],
  },
  {
    date: "2026-07-31",
    title: "v1 — the console",
    items: [
      "Dashboard, Portfolio, Keywords (table + opportunity matrix), Rankings, Competitors, Reviews, Activity, Alerts, Listing Manager, Listing Helper, Autocomplete Simulator, Revenue estimates.",
      "Nightly crawler on GitHub Actions: rankings 250-deep, app snapshots, reviews, discovery, rollups, alert evaluation and the daily email digest.",
      "All of it on free public store data — no paid vendor, $0/month.",
    ],
  },
];

export default function WhatsNewPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <p className="mb-1 text-[12px] text-[var(--fg-subtle)]"><Link href="/" className="hover:text-[var(--fg)]">trysearch</Link> · changelog</p>
      <h1 className="mb-8 text-[22px] font-semibold">What&apos;s New</h1>
      <div className="space-y-10">
        {ENTRIES.map((e, i) => (
          <section key={i}>
            <p className="num text-[11px] text-[var(--fg-subtle)]">{e.date}</p>
            <h2 className="mb-2 text-[15px] font-semibold">{e.title}</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-[var(--fg-muted)]">
              {e.items.map((item, j) => <li key={j}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
