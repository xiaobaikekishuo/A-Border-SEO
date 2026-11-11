import type { Translator } from "@/lib/i18n/shared";
import { localizedObservation, localizedIssueType, localizedRemediation } from "@/lib/i18n/audit";
import { getI18n } from "@/lib/i18n/server";
import { auth } from "@/lib/auth";
import { crawlPageCeiling } from "@/lib/jobs/policy";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { CrawlButton } from "@/components/sites/action-buttons";
import { CrawlStatusPoller } from "@/components/sites/crawl-status-poller";
import { CrawlFailedNotice } from "@/components/sites/crawl-failed-notice";
import { CrawledPagesTable, type IndexFilter } from "@/components/sites/crawled-pages-table";
import { NoindexWarningNotice } from "@/components/sites/noindex-warning";
import { getNoindexWarning } from "@/lib/crawler/noindex-warning";
import { RobotsPanel } from "@/components/sites/robots-panel";
import { CrawlComparison } from "@/components/sites/crawl-comparison";
import { cn } from "@/lib/utils";
import { formatDay } from "@/lib/format";
import { getVisibleIssues } from "@/lib/crawler/issue-filter";
import { auditIssueDisplayType } from "@/lib/crawler/audit-policy";
import { getCrawlActivity } from "@/lib/jobs/site-jobs";
import { crawledPageColumns, getCrawlPageStats, getCrawlRobotsReport } from "@/lib/crawler/page-stats";

const ISSUE_ROWS = 200;

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<{ pages?: string | string[] }>;
}

export default async function CrawlPage({ params, searchParams }: Props) {
  const { t, locale } = await getI18n();
  const session = await auth();
  const { siteId } = await params;
  // ?pages=noindex opens the Crawled pages table on its noindex filter.
  const pagesParam = (await searchParams)?.pages;
  const initialFilter: IndexFilter = pagesParam === "noindex" || pagesParam === "indexable" ? pagesParam : "all";

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  const latest = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
  });

  // A crawl job queued or running, or the failure of the last attempt since
  // `latest`. A crawl whose process died shows as failed or queued again, not
  // in progress.
  const { active: activeCrawl, failed: failedCrawl } = await getCrawlActivity(
    db,
    siteId,
    latest?.finishedAt ?? null
  );

  // Issues a user sees (no crawl summary or content score rows). The table
  // lists up to ISSUE_ROWS of them; the counts cover all of them.
  const { issues, total: issueTotal, bySeverity, auditReview } = latest
    ? await getVisibleIssues(db, latest.id, ISSUE_ROWS)
    : { issues: [], total: 0, bySeverity: { CRITICAL: 0, WARNING: 0, INFO: 0 }, auditReview: null };

  // Page counts come from the database over every stored page, and the table
  // gets every row (a crawl stores at most 2000), so no count depends on a
  // capped list.
  const [pageStats, auditPages, robotsReport, noindexWarning] = latest
    ? await Promise.all([
        getCrawlPageStats(db, latest.id),
        db.auditPage.findMany({
          where: { crawlId: latest.id },
          orderBy: [{ contentScore: "desc" }, { url: "asc" }],
          select: crawledPageColumns,
        }),
        getCrawlRobotsReport(db, latest.id),
        getNoindexWarning(db, latest.id),
      ])
    : [{ pages: 0, avgContentScore: null, orphans: 0, noindex: 0 }, [], null, null];
  const { avgContentScore, orphans: orphanCount, noindex: noindexCount } = pageStats;

  const crawledAt = latest?.finishedAt ? formatDay(latest.finishedAt, {locale,  time: true }) : null;
  const limitedSample = latest && latest.maxPages > 0 && latest.pagesFound >= latest.maxPages;

  return (
    <div>
      <PageHeader
        title={t("Crawl / Audit", "抓取 / 审计")}
        meta={
          latest
            ? t("Crawl {date} · {pages} crawled", "抓取时间 {date} · 已抓取 {pages}", {date: crawledAt ?? "", pages: locale === "zh" ? `${pageStats.pages} 个页面` : plural(pageStats.pages, "page")})
            : t("No crawl yet", "暂无抓取记录")
        }
        actions={<CrawlButton siteId={siteId} pageCeiling={crawlPageCeiling()} />}
      />

      {/* Queued or running crawl indicator */}
      {activeCrawl && (
        <CrawlStatusPoller key={activeCrawl.jobId} jobId={activeCrawl.jobId} status={activeCrawl.status} />
      )}
      {failedCrawl && <CrawlFailedNotice error={failedCrawl.error} finishedAt={failedCrawl.finishedAt} />}

      {!latest ? (
        <EmptyState
          illustration="empty-crawl"
          title={t("No crawl yet", "暂无抓取记录")}
          description={t("Run a crawl to check titles, H1s, canonicals, broken pages, sitemap coverage, and on-page content scores.", "运行抓取，检查标题、H1、规范网址、失效页面、站点地图覆盖及页面内容评分。")}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <CrawlComparison key={siteId} siteId={siteId} />
          {noindexWarning && (
            <NoindexWarningNotice warning={noindexWarning} href={`/sites/${siteId}/crawl?pages=noindex#crawled-pages`} />
          )}
          {limitedSample && (
            <section className="panel px-5 py-4" aria-label={t("Crawl coverage", "抓取覆盖范围")}>
              <h2 className="text-[13px] font-semibold text-text-strong">{t("Limited crawl sample", "抓取样本有限")}</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {t("Reached the {limit}-page limit. Findings and health describe the crawled sample. Potential orphan pages may have inbound links outside this sample.", "已达到 {limit} 页的抓取上限。问题与健康分仅描述本次抓取样本。疑似孤立页可能存在来自样本之外的内部链接。", {limit: latest.maxPages})}
              </p>
            </section>
          )}
          {auditReview && (auditReview.excluded > 0 || auditReview.unverified > 0) && (
            <section className="panel px-5 py-4" aria-label={t("Audit review", "审计复核")}>
              <h2 className="text-[13px] font-semibold text-text-strong">{t("Audit review", "审计复核")}</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{localizedObservation(auditReview.message, locale)}</p>
            </section>
          )}
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div className="panel col-span-2 flex flex-col gap-2.5 px-5 py-[18px] lg:col-span-1">
              <span className="text-[13px] leading-5 text-muted-foreground">{t("Health", "健康分")}</span>
              <span className="font-data text-[40px] leading-[44px] font-medium tracking-[-0.03em] text-text-strong">
                {latest.healthScore ?? t("n/a", "暂无")}
                <span className="ml-1 text-[15px] tracking-normal text-muted-foreground">/100</span>
              </span>
              <span className="mono-label text-[11px] leading-[1.5] text-muted-foreground">
                {t("Latest completed crawl · content avg {score}/100", "最近完成的抓取 · 平均内容分 {score}/100", {score: avgContentScore ?? t("n/a", "暂无")})}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted-foreground" title={latest.healthScoreVersion ? t("Each issue type takes off up to 30 (critical), 12 (warning) or 3 (info) points, scaled by the square root of the share of audited pages it affects (noindex pages are not audited).", "每类问题最多扣 30（严重）、12（警告）或 3（提示）分，按受影响页面占已审计页面（不含 noindex 页面）比例的平方根折算。") : t("Scored before this version: 8, 3 or 1 points per finding. Run a new crawl to use the page-share score.", "此次抓取使用旧算法：每个问题扣 8、3 或 1 分。重新抓取即可使用按占比计分。")}>
                {latest.healthScoreVersion ? t("Scoring: share of affected pages", "计分方式：按受影响页面占比") : t("Scoring: legacy per-finding deduction", "计分方式：旧版逐项扣分")}
              </span>
              {noindexWarning && (
                <span className="text-[12px] leading-[18px] text-warning">
                  {t("Not a healthy result: most pages are noindex and not scored", "此结果不代表健康：大多数页面设置了 noindex，未计入评分")}</span>
              )}
            </div>
            <CountCard label={t("Critical", "严重")} n={bySeverity.CRITICAL} note={t("Blocks indexing or users", "阻碍收录或用户访问")} tone="danger" />
            <CountCard label={t("Warning", "警告")} n={bySeverity.WARNING} note={t("Hurts ranking", "可能影响排名")} tone="warning" />
            <CountCard label={t("Info", "提示")} n={bySeverity.INFO} note={t("Worth knowing", "供参考")} />
          </div>

          <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[2.3fr_1fr]">
            {/* Issues list with remediation */}
            <section className="panel overflow-hidden">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-1.5">
                <h2 className="text-[15px] leading-5 font-semibold">{t("Issues", "问题列表")}</h2>
                <span className="mono-label text-[11px] text-muted-foreground">
                  {locale === "zh" ? `${issueTotal} 个问题` : plural(issueTotal, "issue")}
                </span>
              </div>
              {issueTotal === 0 ? (
                <p className="px-4 pt-2 pb-6 text-[13px] text-muted-foreground">{t("No issues found", "未发现问题")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[13px]">
                    <thead>
                      <tr className="border-b border-border">
                        <th className={th}>{t("Severity", "严重程度")}</th>
                        <th className={th}>{t("Issue", "问题")}</th>
                        <th className={th}>{t("Page", "页面")}</th>
                        <th className={th}>{t("Type", "类型")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-soft">
                      {issues.map((issue) => {
                        const details = issue.details as { howToFix?: string; kind?: string } | null;
                        return (
                          <tr key={issue.id} className="align-top">
                            <td className="px-4 py-3">
                              <SeverityChip severity={issue.severity} t={t} />
                            </td>
                            <td className="px-4 py-3">
                              <p className="text-text-strong">{localizedObservation(issue.message, locale)}</p>
                              {details?.howToFix && (
                                <p className="mt-1 text-[12px] leading-[18px] text-muted-foreground">
                                  <span className="font-medium text-text">{t("Fix: ", "修复建议：")}</span>
                                  {details.kind === "not_in_sitemap"
                                    ? t("Review sitemap coverage of preferred canonical URLs. Inclusion is optional; pages can also be discovered through internal links.", "核查首选规范网址的站点地图覆盖。列入地图是可选的，搜索引擎也可通过内部链接发现页面。")
                                    : issue.type === "DUPLICATE_DESCRIPTION"
                                      ? t("Distinct descriptions may help search snippets. Paginated sequences may share descriptions; review the page purpose before changing metadata.", "独立描述可能有助于搜索摘要。分页序列可以共用描述，修改元数据前请核查页面用途。")
                                      : localizedRemediation(issue.type, details.howToFix, locale)}
                                </p>
                              )}
                            </td>
                            <td className="max-w-[260px] truncate px-4 py-3 font-data text-[12px]" title={issue.url}>
                              {pathOf(issue.url)}
                            </td>
                            <td className="px-4 py-3 mono-label text-[11px] whitespace-nowrap text-muted-foreground">
                              {localizedIssueType(auditIssueDisplayType({ type: issue.type, details }), locale)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {issueTotal > issues.length && (
                    <p className="border-t border-border bg-bg-soft px-4 py-3 text-[12px] text-muted-foreground">
                      {t("Showing {shown} of {total} issues, most severe first", "显示 {total} 个问题中的 {shown} 个，按严重程度排序", {shown: issues.length, total: issueTotal})}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="panel flex flex-col gap-2.5 self-start px-5 py-[18px]">
              <h2 className="text-[15px] leading-5 font-semibold">{t("Internal links", "内部链接")}</h2>
              <div className="flex justify-between gap-3 text-[13px]">
                <span>{t("Potential orphans", "疑似孤立页")}</span>
                <span className="font-data text-text-strong">{orphanCount}</span>
              </div>
              <p className="text-[12px] leading-[18px] text-muted-foreground">
                {t("No inbound link found in this crawl. Links outside the crawled sample may exist.", "本次抓取未发现指向该页面的内部链接。抓取样本以外可能存在链接。")}</p>
              <div className="flex justify-between gap-3 text-[13px]">
                <span>{t("Content score, average", "平均内容分")}</span>
                <span className="font-data text-text-strong">{avgContentScore ?? t("n/a", "暂无")}</span>
              </div>
              <div className="flex justify-between gap-3 text-[13px]">
                <span>{t("noindex (not scored)", "noindex（未评分）")}</span>
                <span className="font-data text-text-strong">{noindexCount}</span>
              </div>
              {noindexCount > 0 && (
                <p className="text-[12px] leading-[18px] text-muted-foreground">
                  {t("Pages with a noindex meta robots tag or X-Robots-Tag header are crawled and their links followed, but they do not count toward the health score or the issues. Check the list for a noindex you did not mean to set.", "带有 noindex robots 元标签或 X-Robots-Tag 响应头的页面仍会被抓取并跟踪链接，但不计入健康分或问题统计。请检查是否误设了 noindex。")}</p>
              )}
              <a href="#crawled-pages" className="text-link text-[13px]">
                {t("See them in Crawled pages", "在已抓取页面中查看")}</a>
            </section>
          </div>

          {robotsReport && <RobotsPanel report={robotsReport} />}

          {/* Crawled pages table (from AuditPage model) */}
          {pageStats.pages > 0 && (
            <section id="crawled-pages" className="scroll-mt-6">
              <div className="flex flex-col gap-1 px-1 pb-3">
                <h2 className="text-[15px] leading-5 font-semibold">{t("Crawled pages", "已抓取页面")}</h2>
                <p className="text-[13px] text-muted-foreground">
                  {t("{pages}, each stored with full metadata", "{pages}，每页均保存完整元数据", {pages: locale === "zh" ? `${pageStats.pages} 个页面` : plural(pageStats.pages, "page")})}
                </p>
              </div>
              {/* Keyed: the warning's link is a soft navigation to this page, which must reset the filter. */}
              <CrawledPagesTable key={initialFilter} rows={auditPages} initialFilter={initialFilter} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function plural(n: number, noun: string) {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

const th = "mono-label px-4 py-2.5 text-left text-[11px] font-normal text-muted-foreground";

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function SeverityChip({ severity, t }: { severity: string; t: Translator }) {
  return (
    <span
      className={cn(
        "mono-label inline-flex rounded-md border px-2 py-0.5 text-[11px] whitespace-nowrap",
        severity === "CRITICAL" && "border-danger/30 bg-danger-bg text-danger",
        severity === "WARNING" && "border-warning/30 bg-warning-bg text-warning",
        severity === "INFO" && "border-border text-text"
      )}
    >
      {({ CRITICAL: t("critical", "严重"), WARNING: t("warning", "警告"), INFO: t("info", "提示") } as Record<string, string>)[severity] ?? severity.toLowerCase()}
    </span>
  );
}

function CountCard({
  label,
  n,
  note,
  tone,
}: {
  label: string;
  n: number;
  note: string;
  tone?: "danger" | "warning";
}) {
  return (
    <div className="panel flex flex-col gap-2.5 px-5 py-[18px]">
      <span className="text-[13px] leading-5 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-data text-[30px] leading-9 font-medium",
          tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-strong"
        )}
      >
        {n}
      </span>
      <span className="text-[12px] leading-4 text-muted-foreground">{note}</span>
    </div>
  );
}

