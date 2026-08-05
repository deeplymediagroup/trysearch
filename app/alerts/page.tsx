import { AppShell, PageHeader, getActiveApp } from "@/components/AppShell";
import { AlertSettings } from "@/components/AlertSettings";
import { Panel, EmptyState, CountryFlag } from "@/components/ui";
import { getAlerts, getAlertSettings } from "@/lib/queries";
import { currentWorkspace, q1 } from "@/lib/db";
import * as fmt from "@/lib/format";

export const metadata = { title: "Alerts — trysearch" };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const ws = await currentWorkspace();
  const { active } = await getActiveApp();
  if (!ws) {
    return (
      <AppShell current="/alerts">
        <PageHeader title="Alerts" />
        <div className="p-6"><EmptyState title="No workspace">Run `npm run db:migrate`.</EmptyState></div>
      </AppShell>
    );
  }

  const [settings, alerts, owner] = await Promise.all([
    getAlertSettings(ws.id),
    getAlerts(ws.id),
    q1<{ email: string; alert_email: string | null; alerts_paused: boolean }>(
      `select email, alert_email, alerts_paused from users where id = $1`,
      [ws.owner_id],
    ),
  ]);

  return (
    <AppShell current="/alerts">
      <PageHeader
        app={active}
        title="Alerts"
        subtitle="Get a daily email when your tracked apps and keywords change. Pick what you want to hear about — everything is off until you turn it on."
      />

      <div className="max-w-[760px] space-y-6 p-6 pt-2">
        <AlertSettings
          initial={Object.fromEntries(Object.entries(settings).map(([k, v]: any) => [k, { enabled: v.enabled, threshold: v.threshold }]))}
          email={owner?.alert_email ?? owner?.email ?? ""}
          paused={owner?.alerts_paused ?? false}
        />

        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-[var(--fg)]">Recent alerts</h2>
          {alerts.length === 0 ? (
            <EmptyState title="No alerts yet">
              Turn on the rules you care about, then the nightly crawl will evaluate them. One digest email per day, not
              one per alert.
            </EmptyState>
          ) : (
            <Panel className="py-1">
              <ul className="divide-y divide-dashed divide-[var(--border)]">
                {alerts.map((a: any) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[12px] text-[var(--fg)]">{a.message}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--fg-subtle)]">
                        <span className="capitalize">{a.kind.replace(/_/g, " ")}</span>
                        {a.country && <CountryFlag country={a.country} />}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-[var(--fg-subtle)]">{fmt.shortDate(a.occurred_on)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </section>
      </div>
    </AppShell>
  );
}
