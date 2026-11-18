import { getI18n } from "@/lib/i18n/server";
import Link from "next/link";
import { crawlPageCeiling } from "@/lib/jobs/policy";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { DashboardMetrics } from "@/components/dashboard/metrics";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import { TopKeywords } from "@/components/dashboard/top-keywords";
import { PageHeader } from "@/components/ui/page-header";
import { ReportAnalysisLink } from "@/components/ai-workbench/report-analysis-link";
import { EmptyState } from "@/components/ui/empty-state";
import { SyncButton } from "@/components/sites/sync-button";
import {
  CrawlButton,
  VitalsButton,
} from "@/components/sites/action-buttons";
import { CsvExportButton } from "@/components/ui/csv-export-button";
import { getAllOpportunities } from "@/lib/seo-opportunities";
import { countVisibleIssues } from "@/lib/crawler/issue-filter";
import { getNoindexWarning } from "@/lib/crawler/noindex-warning";
import { NoindexWarningNotice } from "@/components/sites/noindex-warning";
import { getCrawlActivity } from "@/lib/jobs/site-jobs";
import { cn } from "@/lib/utils";

interface SitePageProps {
  params: Promise<{ siteId: string }>;
}

export default async function SiteOverviewPage({ params }: SitePageProps) {
  const { t } = await getI18n();
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      userId: true,
      domain: true,
      gscProperty: true,
      gscSyncCoverage: { where: { propertyChecked: true }, distinct: ["gscProperty"], select: { gscProperty: true } },
      _count: { select: { keywords: true, pages: true } },
    },
  });

  if (!site || site.userId !== session?.user?.id) {
    redirect("/sites");
  }

  // Search Console anonymises the query dimension on low-traffic sites, so a
  // synced site can have pages but no keywords. Either one means data arrived.
  const hasData = site._count.keywords > 0 || site._count.pages > 0 ||
    site.gscSyncCoverage.some(row => row.gscProperty === site.gscProperty);
  // Start independent reads only after the site's owner has been verified.
  const [crawl, latestVital, opportunities] = await Promise.all([
    getOverviewCrawl(siteId),
    db.vitalsReport.findFirst({
      where: { siteId },
      orderBy: { date: "desc" },
      select: { perfScore: true, lcp: true, url: true },
    }),
    hasData ? getAllOpportunities(siteId) : null,
  ]);
  const { latestCrawl, latestIssueCount, latestPageCount, noindexWarning, crawlActivity } = crawl;

  return (
    <div>
      <PageHeader
        title={t("Overview", "概览")}
        meta={t("Last 28 days vs the previous 28 days", "最近 28 天与前 28 天对比")}
        description={<span className="font-data">{site.gscProperty || site.domain}</span>}
        reserveStatus
        actions={
          <>
            {site.gscProperty ? <SyncButton siteId={siteId} /> : (
              <Link href={`/sites/${siteId}/settings#gsc-connection`} className="text-link text-sm font-medium">
                {t("Connect Search Console", "连接 Search Console")}
              </Link>
            )}
            <CrawlButton siteId={siteId} pageCeiling={crawlPageCeiling()} />
            <VitalsButton siteId={siteId} />
            <ReportAnalysisLink siteId={siteId} scope="weekly" t={t} />
          </>
        }
      />

      {noindexWarning && (
        <div className="mb-[22px]">
          <NoindexWarningNotice warning={noindexWarning} href={`/sites/${siteId}/crawl?pages=noindex#crawled-pages`} />
        </div>
      )}

      {!hasData ? (
        <EmptyState
          illustration="empty-gsc-wait"
          title={site.gscProperty ? t("Waiting for GSC data", "等待 GSC 数据") : t("Your site is ready", "网站已添加")}
          description={site.gscProperty
            ? t("Run a sync to pull keywords, pages, and traffic for the last 28 days.", "运行同步，获取最近 28 天的关键词、页面和流量数据。")
            : t("You can crawl this site and use the Codex workbench now. Connect Search Console in Site settings when you want Google search traffic and keyword data.", "现在可以抓取网站并使用 Codex 工作台。需要 Google 搜索流量和关键词数据时，可在站点设置中连接 Search Console。")}
          actionLabel={!site.gscProperty ? t("Open Codex workbench", "打开 Codex 工作台") : undefined}
          actionHref={!site.gscProperty ? `/sites/${siteId}/assistant` : undefined}
        />
      ) : (
        <div className="flex flex-col gap-[22px]">
          <DashboardMetrics siteId={siteId} />
          <TrafficChart siteId={siteId} />

          <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <TopKeywords siteId={siteId} />

            <section className="panel flex flex-col gap-3 self-start px-5 py-[18px]">
              <h2 className="text-[15px] leading-5 font-semibold">{t("Site checks", "站点检查")}</h2>
              <CheckRow
                label={t("Crawl health", "抓取健康分")}
                value={
                  noindexWarning
                    ? t("Most pages noindex", "大多数页面为 noindex")
                    : latestCrawl?.healthScore != null
                      ? `${latestCrawl.healthScore}/100${latestCrawl.healthScoreVersion ? "" : " · " + t("legacy scoring", "旧算法")}`
                      : t("n/a", "暂无")
                }
                tone={noindexWarning ? "warning" : undefined}
              />
              <CheckRow
                label={t("Crawl", "抓取")}
                value={
                  latestCrawl
                    ? t("{pages} pages · {issues} issues", "{pages} 个页面 · {issues} 个问题", {pages: latestPageCount, issues: latestIssueCount})
                    : t("Not run yet", "尚未运行")
                }
              />
              {crawlActivity.active && (
                <CheckRow label={t("Last crawl", "最近一次抓取")} value={crawlActivity.active.status === "QUEUED" ? t("Queued", "排队中") : t("Running", "运行中")} />
              )}
              {crawlActivity.failed && (
                <div className="flex flex-col gap-0.5">
                  <CheckRow label={t("Last crawl", "最近一次抓取")} value={t("Failed", "失败")} tone="danger" />
                  <p className="text-[12px] leading-4 text-muted-foreground">
                    {crawlActivity.failed.error ?? t("No reason was recorded.", "未记录失败原因。")}
                  </p>
                </div>
              )}
              <CheckRow label={t("Opportunities", "优化机会")} value={String(opportunities?.feed.length ?? 0)} />
              <CheckRow
                label={t("Latest perf score", "最近性能分")}
                value={latestVital?.perfScore != null ? String(latestVital.perfScore) : t("n/a", "暂无")}
              />
              {latestVital?.url && (
                <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
                  <span className="shrink-0 text-text">{t("Tested URL", "检测网址")}</span>
                  <span className="truncate font-data text-[12px] text-text-strong" title={latestVital.url}>
                    {latestVital.url.replace(/^https?:\/\//, "")}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[13px]">
                <Link href={`/sites/${siteId}/crawl`} className="text-link">
                  {t("Crawl / Audit", "抓取 / 审计")}</Link>
                <Link href={`/sites/${siteId}/opportunities`} className="text-link">
                  {t("Opportunities", "优化机会")}</Link>
                <Link href={`/sites/${siteId}/vitals`} className="text-link">
                  {t("Vitals", "核心指标")}</Link>
              </div>
            </section>
          </div>

          <div className="flex flex-wrap gap-2">
            <CsvExportButton siteId={siteId} type="keywords" />
            <CsvExportButton siteId={siteId} type="pages" />
          </div>
        </div>
      )}
    </div>
  );
}

async function getOverviewCrawl(siteId: string) {
  const latestCrawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, healthScore: true, healthScoreVersion: true, finishedAt: true },
  });
  // Counted live with the Crawl / Audit page's rules, so both screens agree,
  // also for crawls stored before issuesFound left out the internal rows.
  const [latestIssueCount, latestPageCount, noindexWarning, crawlActivity] = await Promise.all([
    latestCrawl ? countVisibleIssues(db, latestCrawl.id) : 0,
    latestCrawl ? db.auditPage.count({ where: { crawlId: latestCrawl.id } }) : 0,
    latestCrawl ? getNoindexWarning(db, latestCrawl.id) : null,
    // A crawl in progress, or the failure of the last attempt since latestCrawl.
    getCrawlActivity(db, siteId, latestCrawl?.finishedAt ?? null),
  ]);
  return { latestCrawl, latestIssueCount, latestPageCount, noindexWarning, crawlActivity };
}

function CheckRow({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
      <span className="text-text">{label}</span>
      {/* Numbers in mono; words only in mono uppercase. */}
      <span
        className={cn(
          /^[\d.,/%]+$/.test(value) ? "font-data" : "mono-label text-[12px]",
          tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-strong"
        )}
      >
        {value}
      </span>
    </div>
  );
}
