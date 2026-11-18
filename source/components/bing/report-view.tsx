"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, BarChart3, Database, MousePointerClick, ScanSearch } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { BingReport } from "@/lib/bing/report";
import { buttonVariants } from "@/components/ui/button";
import { BingReportChart } from "./report-chart";
import { BingReportTable } from "./report-table";

export function BingReportView({ report, siteId, domain }: { report: BingReport; siteId: string; domain: string }) {
  const { t, locale } = useI18n();
  const [trafficMetric, setTrafficMetric] = useState<"clicks" | "impressions">("clicks");
  const [table, setTable] = useState<"keywords" | "pages">("keywords");
  const number = (value: number | null) => value === null ? t("Not reported", "未报告") : value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const percent = (value: number | null) => value === null ? t("Unavailable", "暂无") : `${(value * 100).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 2 })}%`;
  const sync = report.latestSync;
  const syncTime = sync?.finishedAt ? new Date(sync.finishedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC" : null;
  const endpointLabels: Record<string, string> = { traffic: t("daily traffic", "每日流量"), queries: t("queries", "搜索词"), pages: t("pages", "页面"), crawl: t("crawl statistics", "抓取统计") };
  const missing = (sync?.partial ?? []).filter(key => Object.hasOwn(endpointLabels, key)).map(key => endpointLabels[key]);
  const cards = [
    { label: t("Bing clicks", "Bing 点击量"), value: number(report.totals.clicks), note: t("Daily traffic records", "依据日流量记录"), Icon: MousePointerClick },
    { label: t("Bing impressions", "Bing 曝光量"), value: number(report.totals.impressions), note: t("Daily traffic records", "依据日流量记录"), Icon: BarChart3 },
    { label: t("Click-through rate", "点击率"), value: percent(report.totals.ctr), note: t("Clicks / impressions", "点击量 ÷ 曝光量"), Icon: ScanSearch },
    { label: t("Indexed pages", "已收录页面"), value: number(report.totals.indexedPages), note: t("Latest reported snapshot in period", "区间内最近有效快照"), Icon: Database },
  ];

  return <div className="space-y-5" aria-label={t("Bing report for {domain}", "{domain} 的 Bing 报表", { domain })}>
    <section className="panel flex flex-wrap items-center justify-between gap-4 px-5 py-4" aria-label={t("Report period", "报表区间")}>
      <div className="space-y-1">
        <p className="font-data text-sm text-text-strong">{report.startDate} <span className="text-muted-foreground">{t("to", "至")}</span> {report.endDate}</p>
        <p className="text-xs text-muted-foreground">{t("UTC dates, through yesterday", "以 UTC 日期统计，截至昨天")}</p>
      </div>
      <div className="flex flex-wrap gap-2" aria-label={t("Choose date range", "选择日期范围")}>
        {([28, 90, 180] as const).map(days => <Link key={days} href={`/sites/${encodeURIComponent(siteId)}/bing?days=${days}`}
          aria-current={report.days === days ? "page" : undefined}
          className={buttonVariants({ variant: report.days === days ? "default" : "outline", size: "sm" })}>
          {t("{days} days", "{days} 天", { days })}
        </Link>)}
      </div>
    </section>

    <div className="flex flex-wrap gap-x-6 gap-y-2 px-1 text-xs leading-5 text-muted-foreground">
      <span>{t("Latest data: {date}", "最新数据日期：{date}", { date: report.latestDataDate ?? t("none yet", "暂无") })}</span>
      <span>{t("Last sync: {status}", "最近同步：{status}", { status: sync?.status === "SUCCEEDED" ? (missing.length ? t("partially completed", "部分完成") : t("completed", "已完成")) : sync?.status === "FAILED" ? t("failed", "失败") : sync?.status === "RUNNING" ? t("running", "运行中") : sync?.status === "QUEUED" ? t("queued", "排队中") : t("not run", "尚未运行") })}{syncTime ? ` · ${syncTime}` : ""}</span>
    </div>

    {(sync?.status === "FAILED" || missing.length > 0) && <div role="status" className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm leading-6 text-text-strong">
      <AlertCircle className="mt-1 size-4 shrink-0 text-warning" aria-hidden />
      <p>{missing.length ? t("The latest sync did not update: {parts}. Other stored data remains visible. Retry the sync to complete the report.", "最近一次同步未更新：{parts}。已保存的其他数据仍可查看，请重试同步以补全报表。", { parts: missing.join(t(", ", "、")) })
        : sync?.errorCode === "REAUTH_REQUIRED" ? t("Bing authorization needs attention. Check the connection in Settings, then sync again.", "Bing 授权需要检查。请在设置中检查连接，然后重新同步。")
          : t("The latest Bing sync failed. Stored data remains visible. Check the connection and try syncing again.", "最近一次 Bing 同步失败。已保存的数据仍可查看，请检查连接并重新同步。")}</p>
    </div>}

    {!report.hasData ? <section className="panel flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <BarChart3 className="size-9 text-primary" aria-hidden />
      <h2 className="text-lg font-semibold text-text-strong">{t("No Bing data in this period", "此区间暂无 Bing 数据")}</h2>
      <p className="max-w-xl text-sm leading-6 text-muted-foreground">{t("Run a Bing sync or choose a longer date range. If Bing returns no records, charts stay empty instead of showing zero traffic.", "请运行 Bing 同步或选择更长的日期范围。Bing 未返回记录时，图表保持空状态，不会显示为零流量。")}</p>
      <Link className="text-sm font-medium text-link" href={`/sites/${encodeURIComponent(siteId)}/settings#bing-connection`}>{t("Check the linked Bing property", "检查已绑定的 Bing 资源")}</Link>
    </section> : <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, note, Icon }) => <section key={label} className="panel min-w-0 px-5 py-4">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><h2>{label}</h2><Icon className="size-4 text-primary" aria-hidden /></div>
          <p className="my-3 break-words font-data text-[28px] leading-8 font-semibold tracking-tight text-text-strong">{value}</p>
          <p className="text-[11px] leading-5 text-muted-foreground">{note}</p>
        </section>)}
      </div>
      <p className="px-1 text-xs leading-5 text-muted-foreground">{t("Totals use returned daily records ({reported} of {days} calendar days). Missing metrics stay unavailable. Indexed pages are a snapshot, not a sum.", "汇总基于已返回的日记录（{days} 天中有 {reported} 天记录），缺失指标保持未知。收录数为快照，不按天累加。", { reported: report.coverage.dailyDays, days: report.days })}</p>

      <BingReportChart title={trafficMetric === "clicks" ? t("Daily Bing clicks", "每日 Bing 点击量") : t("Daily Bing impressions", "每日 Bing 曝光量")}
        description={t("Search traffic over time. Each metric has its own scale.", "查看搜索流量变化，每项指标使用独立刻度。")}
        points={report.daily.map(day => ({ date: day.date, value: day[trafficMetric] }))}
        controls={<div className="flex gap-1 rounded-lg bg-bg-soft p-1" role="group" aria-label={t("Traffic metric", "流量指标")}>
          {(["clicks", "impressions"] as const).map(metric => <button key={metric} type="button" aria-pressed={trafficMetric === metric}
            onClick={() => setTrafficMetric(metric)} className={buttonVariants({ variant: trafficMetric === metric ? "default" : "ghost", size: "sm" })}>
            {metric === "clicks" ? t("Clicks", "点击量") : t("Impressions", "曝光量")}</button>)}
        </div>} />

      <div className="grid gap-5 xl:grid-cols-2">
        <BingReportChart title={t("Pages crawled by Bing", "Bing 每日抓取页面")}
          description={t("How many pages Bing reports crawling each day.", "Bing 每天报告的抓取页面数量。")}
          points={report.daily.map(day => ({ date: day.date, value: day.crawledPages }))} color="var(--chart-2)" />
        <BingReportChart title={t("Bing index size", "Bing 收录量变化")}
          description={t("Indexed-page snapshot for each reported date.", "每个报告日期的已收录页面快照。")}
          points={report.daily.map(day => ({ date: day.date, value: day.inIndex }))} color="var(--success)" />
      </div>

      <section className="panel px-5 py-4" aria-label={t("Crawl diagnostics", "抓取诊断")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            [t("Pages crawled in period", "区间抓取页面次数"), report.totals.crawledPages],
            [t("Reported crawl errors", "报告的抓取错误"), report.totals.crawlErrors],
            [t("Blocked by robots.txt", "被 robots.txt 屏蔽"), report.totals.blockedByRobots],
          ].map(([label, value]) => <div key={label as string}><h2 className="text-xs text-muted-foreground">{label}</h2><p className="mt-2 font-data text-xl text-text-strong">{number(value as number | null)}</p></div>)}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("Daily counts are added over the selected period. The same page can be counted on multiple days.", "按区间内日记录累计，同一页面可能在不同日期被重复计数。")}</p>
      </section>

      <section aria-label={t("Bing search details", "Bing 搜索明细")} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-text-strong">{t("Search performance details", "搜索表现明细")}</h2>
          <div className="flex gap-2" role="group" aria-label={t("Report dimension", "报表维度")}>
            {(["keywords", "pages"] as const).map(kind => <button key={kind} type="button" aria-pressed={table === kind} onClick={() => setTable(kind)}
              className={buttonVariants({ variant: table === kind ? "default" : "outline", size: "sm" })}>{kind === "keywords" ? t("Keywords", "关键词") : t("Pages", "页面")}</button>)}
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t("Bing reports queries and pages by week. We include weeks whose end date falls in this range, so the boundaries are approximate and totals can differ from daily traffic. Up to 500 rows per dimension, selected by clicks; filtering and sorting apply to these rows.", "Bing 按周报告搜索词和页面。此处选取结束日期落在区间内的周，因此边界为近似范围，汇总可能与日流量不同。每个维度按点击量选取最多 500 条，筛选和排序在这些记录中进行。")}</p>
        <p className="text-xs text-muted-foreground">{t("Query weeks: {queries} · Page weeks: {pages}. Position is impression-weighted; missing values are not zero.", "搜索词覆盖 {queries} 周 · 页面覆盖 {pages} 周。排名按曝光加权，缺失值不视为零。", { queries: report.coverage.queryWeeks, pages: report.coverage.pageWeeks })}</p>
        <BingReportTable key={table + report.days} rows={table === "keywords" ? report.keywords : report.pages} kind={table} />
      </section>
    </>}
  </div>;
}
