import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { MaintenanceNotice } from "@/components/layout/maintenance-notice";
import { APP_VERSION } from "@/lib/version";
import { availableUpdate } from "@/lib/update-check";
import { managedDecision } from "@/lib/managed/policy";
import { currentHostedPolicy, hostedMode } from "@/lib/hosted/access";
import { getI18n } from "@/lib/i18n/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const management = hostedMode()
    ? await currentHostedPolicy().catch(() => redirect("/managed-status"))
    : managedDecision();
  if (management && !management.allowed && management.reason !== "maintenance") redirect("/managed-status");
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const sites = await db.site.findMany({
    where: { userId: session.user?.id },
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });

  // Latest day of Search Console data per site, for the sidebar status block.
  const latest = sites.length
    ? await db.page.groupBy({
        by: ["siteId"],
        where: { siteId: { in: sites.map((s) => s.id) } },
        _max: { date: true },
      })
    : [];
  const dataThrough = Object.fromEntries(
    latest.map((row) => [row.siteId, row._max.date?.toISOString().slice(0, 10) ?? null])
  );
  const { t } = await getI18n();

  return (
    <AppShell
      email={session.user?.email}
      name={session.user?.name}
      image={session.user?.image}
      version={APP_VERSION}
      update={availableUpdate()}
      sites={sites.map((s) => ({ ...s, dataThrough: dataThrough[s.id] ?? null }))}
    >
      <MaintenanceNotice hosted={hostedMode()} initial={{ maintenance: management?.reason === "maintenance", message: management?.maintenanceMessage ?? "" }}
        maintenanceText={t("Maintenance is in progress. New workspace operations are paused.", "系统维护中，工作台暂停接收新操作。")}
        unavailableText={t("Unable to verify the current device policy. Retrying.", "暂时无法验证当前设备策略，正在重试。")} />
      {children}
    </AppShell>
  );
}
