/**
 * /research — research projects (Workstream J): size a niche end-to-end (seed → score →
 * cherry-pick → push to tracking) without creating a fake tracked app.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { ResearchView } from "@/components/ResearchView";
import { listResearchProjects, getResearchKeywords, listTrackedApps } from "@/lib/queries";
import { currentWorkspace } from "@/lib/db";

export const metadata = { title: "Research — trysearch" };
export const dynamic = "force-dynamic";

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const { active } = await getActiveApp();
  const ws = await currentWorkspace();
  const projects = ws ? await listResearchProjects(ws.id) : [];
  const selected = projects.find((p) => p.id === id) ?? projects[0] ?? null;
  const rows = selected ? await getResearchKeywords(selected.id) : [];
  const ownApps = (await listTrackedApps())
    .filter((a) => a.role === "own")
    .map((a) => ({ tracked_app_id: a.tracked_app_id, name: a.name, platform: a.platform }));

  return (
    <AppShell current="/research">
      <PageHeader
        app={active ?? undefined}
        title="Research"
        subtitle="Standalone keyword research — explore a niche or a new market without touching your tracked apps."
      />
      <ResearchView projects={projects} selected={selected} rows={rows} ownApps={ownApps} />
    </AppShell>
  );
}
