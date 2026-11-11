import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { DeleteSiteButton } from "@/components/sites/delete-site-button";
import { BingSiteSection } from "@/components/settings/bing-site-section";
import { formatDay } from "@/lib/format";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function SettingsPage({ params }: Props) {
  const { t, locale } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      userId: true,
      domain: true,
      gscProperty: true,
      bingSite: true,
      createdAt: true,
      _count: {
        select: {
          keywords: true,
          pages: true,
          crawls: true,
          vitals: true,
          alerts: true,
          savedKeywords: true,
        },
      },
    },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  // The Bing key is stored per user, in Settings; this page only picks the property.
  const bingKey = await db.apiKey.findUnique({
    where: { userId_provider: { userId: session.user.id, provider: "bing" } },
    select: { id: true },
  });

  return (
    <div>
      <PageHeader
        title={t("Site settings", "站点设置")}
        description={t("Configuration and stored data for {domain}. API keys and Google live in Settings and apply to all sites.", "{domain} 的配置与已存数据。API 密钥和 Google 连接在设置中统一管理，适用于所有站点。", {domain: site.domain})}
      />

      <div className="space-y-6">
        {/* Site info */}
        <div className="panel p-5">
          <h3 className="text-[15px] leading-5 font-semibold text-text-strong">
            {t("Site details", "站点信息")}</h3>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("Domain", "域名")}</dt>
              <dd className="font-medium text-text-strong">{site.domain}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("GSC property", "GSC 资源")}</dt>
              <dd className="font-medium text-text-strong">
                {site.gscProperty || t("Not connected", "未连接")}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("Bing property", "Bing 资源")}</dt>
              <dd className="font-medium text-text-strong">
                {site.bingSite || t("Not connected", "未连接")}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("Added", "添加时间")}</dt>
              <dd className="font-medium text-text-strong">
                {formatDay(site.createdAt, {locale,  year: true })}
              </dd>
            </div>
          </dl>
        </div>

        {/* Bing Webmaster property: only with a Bing key */}
        {bingKey ? (
          <BingSiteSection siteId={siteId} bingSite={site.bingSite} />
        ) : (
          <p className="panel px-5 py-4 text-sm text-muted-foreground">
            {t("Bing Webmaster Tools is not connected.", "尚未连接 Bing 站长工具。")}{" "}
            <Link href="/settings?connect=bing#connections" className="text-link font-medium">
              {t("Connect Bing in Settings", "在设置中连接 Bing")}</Link>
          </p>
        )}

        {/* Data summary */}
        <section aria-labelledby="stored-data-heading">
          <h3 id="stored-data-heading" className="mb-3 text-[15px] leading-5 font-semibold text-text-strong">
            {t("Stored data", "已存数据")}</h3>
          <ul className="panel divide-y divide-border-soft">
            <DataStat label={t("Keyword records", "关键词记录")} value={site._count.keywords} />
            <DataStat label={t("Page records", "页面记录")} value={site._count.pages} />
            <DataStat label={t("Crawls", "抓取记录")} value={site._count.crawls} />
            <DataStat label={t("Vitals reports", "核心指标报告")} value={site._count.vitals} />
            <DataStat label={t("Alert rules", "告警规则")} value={site._count.alerts} />
            <DataStat label={t("Saved keywords", "已保存关键词")} value={site._count.savedKeywords} />
          </ul>
        </section>

        {/* Danger zone */}
        <div className="panel border-danger/30 p-5">
          <h3 className="text-[15px] leading-5 font-semibold text-danger">
            {t("Danger zone", "危险操作")}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Permanently delete this site and all associated data. This action cannot be undone.", "永久删除此站点及其全部关联数据。此操作无法撤销。")}</p>
          <div className="mt-4">
            <DeleteSiteButton siteId={siteId} domain={site.domain} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DataStat({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-data font-medium text-text-strong">{value.toLocaleString()}</span>
    </li>
  );
}
