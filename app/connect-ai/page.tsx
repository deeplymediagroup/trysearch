/**
 * /connect-ai — the prompt library. How to point Claude (or any MCP client) at /mcp,
 * plus copy-paste prompts that exercise the whole op registry.
 */
import { AppShell, PageHeader } from "@/components/AppShell";
import { CopyButton } from "./CopyButton";

export const metadata = { title: "Connect AI — trysearch" };

const SETUP = [
  {
    title: "1. Mint an API key",
    code: `node scripts/create-api-key.mjs "claude" # read-only (safe default)
node scripts/create-api-key.mjs "claude" --scope write # may also track/untrack`,
  },
  {
    title: "2. Connect Claude Code",
    code: `claude mcp add --transport http trysearch https://<host>/mcp --header "Authorization: Bearer ts_..."`,
  },
  {
    title: "Any other MCP client",
    code: `URL:    https://<host>/mcp
Header: Authorization: Bearer ts_...`,
  },
];

const PROMPTS = [
  "Which of my keywords are winnable this week? Cross-reference rank, difficulty and popularity, and give me the 5 best moves.",
  "Compare me to my top competitor: where do they rank that I don't, and which of those gaps are actually worth chasing?",
  "Summarize my last 30 days: rank movement, alerts, and any competitor listing changes I should react to.",
  "Read my worst recent reviews (1-2 stars) and group them into themes. Which theme costs me the most installs?",
  "Audit my listing with the ASO score op and rewrite my subtitle three ways to target my highest-opportunity keyword.",
  "Find 20 new keyword ideas for my app, check live metrics for the promising ones, and track the top 5 for me.",
  "Which apps entered the top-10 SERP for my starred keywords this month, and what changed in their listings?",
  "Estimate the monthly revenue of my top 5 competitors and rank them. Who is growing on which keywords?",
  "Check the discoveries feed: which discovered keywords have opportunity above 60, and should I promote any to tracked?",
  "Set an alert rule so I'm told about any rank drop of 5 or more, then list all my active alert rules back to me.",
];

export default async function ConnectAiPage() {
  return (
    <AppShell current="/connect-ai">
      <PageHeader title="Connect AI" subtitle="Point Claude — or any MCP client — at your workspace and just ask." />
      <div className="max-w-2xl space-y-8 px-6 pb-12">
        <section className="space-y-3">
          {SETUP.map((s) => (
            <div key={s.title}>
              <h2 className="th mb-1.5">{s.title}</h2>
              <div className="flex items-start gap-2">
                <pre className="num min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-hover)] p-2.5 text-[12px] leading-relaxed">
                  {s.code}
                </pre>
                <CopyButton text={s.code} />
              </div>
            </div>
          ))}
          <p className="text-[11px] text-[var(--fg-subtle)]">
            The MCP server exposes the same operations as the REST API — every tool an agent gets is one it could also call over HTTP.
            A read key cannot modify anything, no matter what it is asked to do.
          </p>
        </section>

        <section>
          <h2 className="th mb-2">Prompts that earn their keep</h2>
          <ul className="space-y-2.5">
            {PROMPTS.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] p-2.5 text-[12.5px] leading-relaxed">
                  {p}
                </pre>
                <CopyButton text={p} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
