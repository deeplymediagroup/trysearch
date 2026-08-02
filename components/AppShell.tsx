/**
 * The global shell — 01-PRODUCT-SPEC.md §0. Sidebar + top bar + content.
 *
 * A Server Component: it reads the tracked-app list straight from Postgres. Only the two
 * genuinely interactive bits (the app switcher dropdown, the sidebar collapse) are client
 * components, and both are CSS/details-driven so navigation makes zero XHR calls.
 */
import Link from "next/link";
import { cookies } from "next/headers";
import { listTrackedApps, type TrackedApp } from "@/lib/queries";
import { PlatformChip } from "./ui";

export const ACTIVE_APP_COOKIE = "trysearch_app";

type NavItem = { label: string; href: string; badge?: string };
type NavGroup = { header: string | null; collapsible: boolean; items: NavItem[] };

/** Exact order and labels from the product spec. */
const NAV: NavGroup[] = [
  {
    header: null,
    collapsible: false,
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Portfolio", href: "/portfolio" },
    ],
  },
  {
    header: "Monitor",
    collapsible: false,
    items: [
      { label: "Keywords", href: "/keywords" },
      { label: "Rankings", href: "/rankings" },
      { label: "Competitors", href: "/competitors" },
      { label: "Reviews", href: "/reviews" },
      { label: "Activity", href: "/activity" },
      { label: "Alerts", href: "/alerts" },
    ],
  },
  {
    header: "Optimize",
    collapsible: true,
    items: [
      { label: "Listing Manager", href: "/listing-manager", badge: "NEW" },
      { label: "Listing Helper", href: "/listing-helper", badge: "NEW" },
      { label: "Autocomplete", href: "/autocomplete", badge: "NEW" },
      { label: "Revenue", href: "/revenue", badge: "ALPHA" },
    ],
  },
  {
    header: "Your App",
    collapsible: true,
    items: [
      { label: "Performance", href: "/performance", badge: "NEW" },
      { label: "Engagement", href: "/engagement", badge: "NEW" },
    ],
  },
];

export async function getActiveApp(): Promise<{ apps: TrackedApp[]; active: TrackedApp | null }> {
  const apps = await listTrackedApps();
  const jar = await cookies();
  const wanted = jar.get(ACTIVE_APP_COOKIE)?.value;
  const active = apps.find((a) => a.tracked_app_id === wanted && a.role === "own")
    ?? apps.find((a) => a.role === "own")
    ?? apps[0]
    ?? null;
  return { apps, active };
}

export async function AppShell({ children, current }: { children: React.ReactNode; current: string }) {
  const { apps, active } = await getActiveApp();
  const own = apps.filter((a) => a.role === "own");

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-panel)]">
        {/* App switcher */}
        <div className="border-b border-[var(--border)] p-2.5">
          <details className="group/switch relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 hover:bg-[var(--bg-hover)]">
              {active?.icon_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={active.icon_url} alt="" width={26} height={26} className="h-[26px] w-[26px] shrink-0 rounded-[7px]" />
              ) : (
                <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-[var(--bg-hover)]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{active?.name ?? "No app yet"}</span>
                {active && <PlatformChip platform={active.platform} />}
              </span>
              <span aria-hidden className="text-[10px] text-[var(--fg-subtle)]">⌄</span>
            </summary>

            <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-[var(--radius-chip)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1 shadow-xl">
              {own.length === 0 && <p className="px-2 py-2 text-[11px] text-[var(--fg-subtle)]">No apps tracked yet.</p>}
              {["ios", "android"].map((platform) => {
                const group = own.filter((a) => a.platform === platform);
                if (!group.length) return null;
                return (
                  <div key={platform}>
                    <p className="th px-2 pt-1.5 pb-1">{platform === "ios" ? "App Store" : "Google Play"}</p>
                    {group.map((a) => (
                      <Link
                        key={a.tracked_app_id}
                        href={`/dashboard?app=${a.tracked_app_id}`}
                        className={`flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] hover:bg-[var(--bg-hover)] ${a.tracked_app_id === active?.tracked_app_id ? "text-[var(--accent)]" : "text-[var(--fg-muted)]"}`}
                      >
                        <span className="truncate">{a.name}</span>
                      </Link>
                    ))}
                  </div>
                );
              })}
              <Link href="/add-app" className="mt-1 block rounded-[5px] border-t border-[var(--border)] px-2 py-2 text-[12px] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]">
                + Add app
              </Link>
            </div>
          </details>
        </div>

        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
          {NAV.map((group) => (
            <div key={group.header ?? "root"} className="mb-2">
              {group.header && (
                <p className="th flex items-center gap-1.5 px-2 pb-1 pt-2">
                  {group.header}
                </p>
              )}
              <ul>
                {group.items.map((item) => {
                  const isActive = current === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={`flex items-center justify-between rounded-[var(--radius-chip)] px-2 py-1.5 text-[12.5px] transition-colors ${
                          isActive
                            ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.badge && (
                          <span className="rounded-[4px] bg-[var(--bg-hover)] px-1 py-0.5 text-[9px] font-semibold tracking-wide text-[var(--fg-subtle)]">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--border)] p-2.5">
          <Link href="/whats-new" className="mb-1.5 block text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
            What&apos;s New
          </Link>
          <p className="text-[10px] leading-relaxed text-[var(--fg-subtle)]">
            All data from free public App Store and Google Play endpoints. No paid vendor.
          </p>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

/** PageHeader — app icon, name, platform chip, subtitle line, right-aligned action slot. */
export function PageHeader({
  app,
  title,
  subtitle,
  actions,
}: {
  app?: TrackedApp | null;
  title?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {app?.icon_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={app.icon_url} alt="" width={38} height={38} className="h-[38px] w-[38px] shrink-0 rounded-[9px]" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[16px] font-semibold">{title ?? app?.name ?? "trysearch"}</h1>
            {app && <PlatformChip platform={app.platform} />}
          </div>
          {subtitle && <div className="mt-0.5 text-[12px] text-[var(--fg-muted)]">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
