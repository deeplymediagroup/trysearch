import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { ListingManager } from "@/components/ListingManager";
import { EmptyState } from "@/components/ui";
import { getListings, getLatestSnapshot, getCountries, getTargetKeywords } from "@/lib/queries";

export const metadata = { title: "Listing Manager — trysearch" };
export const dynamic = "force-dynamic";

export default async function ListingManagerPage() {
  const { active } = await getActiveApp();
  if (!active) {
    return (
      <AppShell current="/listing-manager">
        <PageHeader title="Listing Manager" />
        <div className="p-6"><EmptyState title="No app tracked yet">Track an app first.</EmptyState></div>
      </AppShell>
    );
  }

  const countries = await getCountries(active.tracked_app_id);
  const stored = await getListings(active.tracked_app_id);

  // Fall back to the daily store snapshot when App Store Connect is not connected: the public
  // page gives us App Name, Subtitle and Description for free. The 100-char keyword field is
  // never public, so it stays empty and the UI says why.
  let listings = stored as any[];
  if (!listings.length) {
    const snaps = await Promise.all(
      (countries.length ? countries : ["us"]).map(async (cc) => {
        const s: any = await getLatestSnapshot(active.app_id, cc);
        if (!s) return null;
        return {
          locale: cc === "us" ? "en-US" : cc === "gb" ? "en-GB" : cc === "ca" ? "en-CA" : cc === "au" ? "en-AU" : cc,
          status: "live",
          is_primary: cc === "us",
          app_name: s.name,
          subtitle: s.subtitle,
          keywords_field: null,
          promotional_text: null,
          description: s.description,
          release_notes: s.release_notes,
          source: "store",
          screenshot_urls: s.screenshot_urls ?? [],
        };
      }),
    );
    listings = snaps.filter(Boolean) as any[];
  }

  const primary: any = await getLatestSnapshot(active.app_id, countries[0] ?? "us");
  const targets = await getTargetKeywords(active.tracked_app_id, listings[0]?.locale ?? "en-US");

  return (
    <AppShell current="/listing-manager">
      <PageHeader
        app={active}
        title="Listing Manager"
        subtitle="Your live store listing in every language — see what's filled in, spot gaps, and jump straight into editing."
      />
      <ListingManager
        listings={listings}
        screenshots={(primary?.screenshot_urls ?? []) as string[]}
        iconUrl={active.icon_url}
        targets={targets as any}
      />
    </AppShell>
  );
}
