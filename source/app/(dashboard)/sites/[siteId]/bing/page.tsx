import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getI18n } from "@/lib/i18n/server";
import { getBingReport } from "@/lib/bing/report";
import { managedAllows } from "@/lib/managed/policy";
import { currentHostedFeatureAllowed, hostedMode } from "@/lib/hosted/access";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { PageHeader } from "@/components/ui/page-header";
import { ReportAnalysisLink } from "@/components/ai-workbench/report-analysis-link";
import { EmptyState } from "@/components/ui/empty-state";
import { BingSiteSection } from "@/components/settings/bing-site-section";
import { BingReportView } from "@/components/bing/report-view";
import { BingSyncButton } from "@/components/sites/bing-sync-button";

export default async function BingReportPage({ params, searchParams }: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { siteId } = await params;
  const site = await db.site.findFirst({ where: { id: siteId, userId: session.user.id },
    select: { domain: true, bingSite: true } });
  if (!site) redirect("/sites");
  const { t } = await getI18n();
  const { days: rawDays } = await searchParams;
  const days = rawDays === "90" ? 90 : rawDays === "180" ? 180 : 28;
  const key = await db.apiKey.findUnique({ where: { userId_provider: { userId: session.user.id, provider: "bing" } },
    select: { id: true } });
  const syncAllowed = !desktopMaintenanceActive() && (hostedMode() ? await currentHostedFeatureAllowed("jobs") : managedAllows("jobs"));
  const report = key && site.bingSite ? await getBingReport(siteId, days) : null;

  return <div>
    <PageHeader title={t("Bing reports", "Bing 报表")} meta={site.domain}
      description={t("Search traffic, keywords, pages and crawl health from Bing Webmaster Tools.", "查看必应搜索流量、关键词、页面表现和抓取收录情况。")}
      reserveStatus
      actions={<>
        <Link href={`/sites/${siteId}/settings#bing-connection`} className="text-link text-sm font-medium">
          {t("Bing connection settings", "Bing 连接设置")}
        </Link>
        {report && <BingSyncButton key={siteId} siteId={siteId} disabled={!syncAllowed} />}
        <ReportAnalysisLink siteId={siteId} scope="bing" t={t} />
      </>} />
    {!syncAllowed && <p role="status" className="mb-5 rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm text-warning">
      {t("Sync is unavailable under the current workspace policy or maintenance state. Saved reports remain readable.", "当前授权策略或维护状态暂停了同步，仍可查看已保存的报表。")}
    </p>}
    {!key ? <EmptyState title={t("Connect Bing Webmaster Tools", "连接 Bing 站长工具")}
      description={t("Save your Bing API key in account settings, then bind a verified site to start syncing reports.", "先在账号设置中保存 Bing API 密钥，再绑定已验证的网站并同步报表。")}
      actionLabel={t("Open connection settings", "打开连接设置")} actionHref="/settings?connect=bing#connections" />
      : !site.bingSite ? <div className="space-y-5">
        <EmptyState title={t("Choose this site's Bing property", "为此网站选择 Bing 资源")}
          description={t("Your account connection is saved. Select the matching verified Bing site below, save it, then sync to populate this report.", "账号连接已保存。请在下方选择与当前网站对应的已验证 Bing 资源，保存后同步，即可生成报表。")}/>
        {syncAllowed && <BingSiteSection siteId={siteId} bingSite={null} />}
      </div>
      : report && <BingReportView key={siteId} siteId={siteId} domain={site.domain} report={report} />}
  </div>;
}
