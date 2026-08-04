/**
 * The global shell — 01-PRODUCT-SPEC.md §0. Sidebar + top bar + content.
 *
 * A Server Component: it reads the tracked-app list straight from Postgres. Only the two
 * genuinely interactive bits (the app switcher dropdown, the sidebar collapse) are client
 * components, and both are CSS/details-driven so navigation makes zero XHR calls.
 */
import Link from "next/link";
import { cookies } from "next/headers";
import {
  LayoutGrid,
  Folder,
  Search,
  TrendingUp,
  Users,
  MessageSquare,
  Activity,
  Bell,
  FileText,
  Sparkles,
  Keyboard,
  BarChart3,
  FlaskConical,
  DollarSign,
  LineChart,
  HeartPulse,
  Megaphone,
  ChevronsUpDown,
  type LucideIcon,
} from "lucide-react";
import { listTrackedApps, type TrackedApp } from "@/lib/queries";
import { PlatformChip } from "./ui";
import { AddAppDialog } from "./AddDialog";

export const ACTIVE_APP_COOKIE = "trysearch_app";

type NavItem = { label: string; href: string; badge?: string; icon: LucideIcon };
type NavGroup = { header: string | null; items: NavItem[] };

/** Exact order and labels from the product spec; grouping mirrors the sidebar design. */
const NAV: NavGroup[] = [
  {
    header: null,
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutGrid },
      { label: "Portfolio", href: "/portfolio", icon: Folder },
    ],
  },
  {
    header: "Track",
    items: [
      { label: "Keywords", href: "/keywords", icon: Search },
      { label: "Rankings", href: "/rankings", icon: TrendingUp },
      { label: "Competitors", href: "/competitors", icon: Users },
      { label: "Reviews", href: "/reviews", icon: MessageSquare },
      { label: "Activity", href: "/activity", icon: Activity },
      { label: "Alerts", href: "/alerts", icon: Bell },
    ],
  },
  {
    header: "Tools",
    items: [
      { label: "Listing Manager", href: "/listing-manager", icon: FileText },
      { label: "Listing Helper", href: "/listing-helper", badge: "NEW", icon: Sparkles },
      { label: "Autocomplete", href: "/autocomplete", icon: Keyboard },
      { label: "Top Charts", href: "/top-charts", badge: "NEW", icon: BarChart3 },
      { label: "Research", href: "/research", badge: "NEW", icon: FlaskConical },
      { label: "Revenue", href: "/revenue", badge: "ALPHA", icon: DollarSign },
    ],
  },
  {
    header: "Your App",
    items: [
      { label: "Performance", href: "/performance", icon: LineChart },
      { label: "Engagement", href: "/engagement", icon: HeartPulse },
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
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
        {/* App switcher */}
        <div className="p-3">
          <details className="group/switch relative">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-[var(--bg-hover)]">
              {active?.icon_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={active.icon_url} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-[8px]" />
              ) : (
                <span className="h-8 w-8 shrink-0 rounded-[8px] bg-[var(--bg-hover)]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{active?.name ?? "No app yet"}</span>
                {active && (
                  <span className="block text-[11px] leading-tight text-[var(--fg-subtle)]">
                    {active.platform === "ios" ? "ios" : "android"}
                  </span>
                )}
              </span>
              <ChevronsUpDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--fg-subtle)]" />
            </summary>

            <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] p-1 shadow-lg">
              {own.length === 0 && <p className="px-2 py-2 text-[11px] text-[var(--fg-subtle)]">No apps tracked yet.</p>}
              {["ios", "android"].map((platform) => {
                const group = own.filter((a) => a.platform === platform);
                if (!group.length) return null;
                return (
                  <div key={platform}>
                    <p className="px-2 pt-1.5 pb-1 text-[11px] text-[var(--fg-subtle)]">{platform === "ios" ? "App Store" : "Google Play"}</p>
                    {group.map((a) => (
                      <Link
                        key={a.tracked_app_id}
                        href={`/dashboard?app=${a.tracked_app_id}`}
                        className={`flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-[var(--bg-hover)] ${a.tracked_app_id === active?.tracked_app_id ? "font-medium text-[var(--fg)]" : "text-[var(--fg-muted)]"}`}
                      >
                        <span className="truncate">{a.name}</span>
                      </Link>
                    ))}
                  </div>
                );
              })}
              <div className="mt-1 border-t border-[var(--border)] px-2 py-2">
                <AddAppDialog
                  triggerClass="text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                />
              </div>
            </div>
          </details>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Main">
          {NAV.map((group) => (
            <div key={group.header ?? "root"}>
              {group.header && (
                <p className="px-2 pb-1.5 pt-5 text-[12px] text-[var(--fg-subtle)]">
                  {group.header}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = current === item.href;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded-[8px] px-2 py-[7px] text-[13.5px] transition-colors ${
                          isActive
                            ? "bg-[var(--bg-hover)] font-medium text-[var(--fg)]"
                            : "text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                        }`}
                      >
                        <Icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge && (
                          <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-white">
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

        <div className="border-t border-[var(--border)] p-3">
          <Link href="/whats-new" className="flex items-center gap-2.5 rounded-[8px] px-2 py-[7px] text-[13.5px] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]">
            <Megaphone aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            <span className="flex-1">What&apos;s New</span>
            <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--accent)]" />
          </Link>
          <p className="mt-1.5 px-2 text-[10px] leading-relaxed text-[var(--fg-subtle)]">
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
    <header className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-6">
      <div className="flex min-w-0 items-center gap-3.5">
        {app?.icon_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={app.icon_url} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-[11px]" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[21px] font-bold tracking-tight">{title ?? app?.name ?? "trysearch"}</h1>
            {app && <PlatformChip platform={app.platform} />}
          </div>
          {subtitle && <div className="mt-0.5 text-[13px] text-[var(--fg-subtle)]">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
