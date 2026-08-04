/**
 * /screenshots — Screenshot Studio: design App Store screenshots per device size,
 * localise the text, export full-resolution PNGs straight from the canvas.
 */
import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { ScreenshotStudio, type SetRow, type SlideRow } from "@/components/ScreenshotStudio";
import { q } from "@/lib/db";

export const metadata = { title: "Screenshots — trysearch" };
export const dynamic = "force-dynamic";

export default async function ScreenshotsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const { active } = await getActiveApp();

  const sets = active
    ? await q<SetRow>(
        `select id, name, device_label, width_px, height_px from screenshot_sets
          where tracked_app_id = $1 order by created_at desc`,
        [active.tracked_app_id],
      )
    : [];
  const selected = sets.find((s) => s.id === id) ?? sets[0] ?? null;
  const slides = selected
    ? await q<SlideRow>(
        `select id, position, config from screenshot_slides
          where set_id = $1 and locale = 'base' order by position`,
        [selected.id],
      )
    : [];

  return (
    <AppShell current="/screenshots">
      <PageHeader
        app={active ?? undefined}
        title="Screenshots"
        subtitle="Design App Store screenshots on a full-resolution canvas — per device size, per locale — and export PNGs."
      />
      <ScreenshotStudio
        key={selected?.id ?? "none"}
        trackedAppId={active?.tracked_app_id ?? null}
        sets={sets}
        selected={selected}
        slides={slides}
      />
    </AppShell>
  );
}
