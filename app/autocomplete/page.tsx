import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { AutocompleteSimulator } from "@/components/AutocompleteSimulator";
import { getCountries, listTrackedApps } from "@/lib/queries";

export const metadata = { title: "Autocomplete Simulator — trysearch" };
export const dynamic = "force-dynamic";

export default async function AutocompletePage() {
  const { active } = await getActiveApp();
  const countries = active ? await getCountries(active.tracked_app_id) : ["us"];
  // Own apps are the "Track as competitor" targets in the SERP drill-down.
  const ownApps = (await listTrackedApps())
    .filter((a) => a.role === "own")
    .map((a) => ({ tracked_app_id: a.tracked_app_id, name: a.name, platform: a.platform }));

  return (
    <AppShell current="/autocomplete">
      <PageHeader
        app={active}
        title="Autocomplete Simulator"
        subtitle="Type like a user and watch the store's live autocomplete, then check how many characters it takes before your keyword shows up."
      />
      <AutocompleteSimulator countries={countries.length ? countries : ["us"]} defaultPlatform={(active?.platform as any) ?? "ios"} ownApps={ownApps} />
    </AppShell>
  );
}
