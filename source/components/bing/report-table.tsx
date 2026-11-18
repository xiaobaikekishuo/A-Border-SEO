"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { MetricTable, sortRows, useTableSort, type MetricHeader } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import type { BingReport } from "@/lib/bing/report";

export function BingReportTable({ rows, kind }: { rows: BingReport["keywords"]; kind: "keywords" | "pages" }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const { sort, toggle } = useTableSort({ key: "clicks", dir: "desc" });
  const filtered = useMemo(() => sortRows(rows.filter(row => row.key.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), sort), [rows, query, sort]);
  const pageSize = 15;
  const shownPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const start = shownPage * pageSize;
  const shown = filtered.slice(start, start + pageSize);
  const number = (value: number | null, fractionDigits = 0) => value === null ? t("Not reported", "未报告") : value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: fractionDigits });
  const percent = (value: number | null) => value === null ? t("Unavailable", "暂无") : `${number(value * 100, 2)}%`;
  const headers: MetricHeader[] = [
    { label: kind === "keywords" ? t("Search query", "搜索词") : t("Page URL", "页面网址"), sortKey: "key", defaultDir: "asc" },
    { label: t("Clicks", "点击量"), sortKey: "clicks", align: "right" },
    { label: t("Impressions", "曝光量"), sortKey: "impressions", align: "right" },
    { label: t("CTR", "点击率"), sortKey: "ctr", align: "right" },
    { label: t("Avg. position", "平均排名"), sortKey: "position", defaultDir: "asc", align: "right" },
    { label: t("Weeks", "周数"), sortKey: "weeks", align: "right" },
  ];

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex min-w-0 flex-1 items-center gap-3 text-sm text-muted-foreground">
        <span className="sr-only">{kind === "keywords" ? t("Filter Bing queries", "筛选 Bing 搜索词") : t("Filter Bing pages", "筛选 Bing 页面")}</span>
        <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}
          placeholder={kind === "keywords" ? t("Search a query…", "输入搜索词筛选…") : t("Search a page URL…", "输入页面网址筛选…")}
          className="h-[38px] w-full max-w-md rounded-md border border-input bg-bg-soft px-3 text-sm text-text-strong placeholder:text-muted-foreground focus:outline-2 focus:outline-ring" />
      </label>
      <span className="text-xs text-muted-foreground">{t("{count} matching rows", "{count} 条匹配记录", { count: filtered.length })}</span>
    </div>
    <MetricTable headers={headers} sort={sort} onSort={(key, dir) => { toggle(key, dir); setPage(0); }} footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <span>{filtered.length ? t("{start} to {end} of {count}", "第 {start} 至 {end} 条，共 {count} 条", { start: start + 1, end: start + shown.length, count: filtered.length }) : t("No matching rows", "没有匹配记录")}</span>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={shownPage === 0} onClick={() => setPage(Math.max(0, shownPage - 1))}>{t("Previous", "上一页")}</Button>
        <Button variant="outline" size="sm" disabled={start + pageSize >= filtered.length} onClick={() => setPage(shownPage + 1)}>{t("Next", "下一页")}</Button></div>
    </div>}>
      {shown.length ? shown.map(row => <tr key={row.key}>
        <td className="max-w-[360px] break-words px-4 py-3 text-text-strong"><span className="block [overflow-wrap:anywhere]">{row.key}</span></td>
        <td className="px-4 py-3 text-right font-data tabular-nums">{number(row.clicks)}</td>
        <td className="px-4 py-3 text-right font-data tabular-nums">{number(row.impressions)}</td>
        <td className="px-4 py-3 text-right font-data tabular-nums">{percent(row.ctr)}</td>
        <td className="px-4 py-3 text-right font-data tabular-nums">{number(row.position, 1)}</td>
        <td className="px-4 py-3 text-right font-data tabular-nums">{number(row.weeks)}</td>
      </tr>) : <tr><td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">{query ? t("Try another query or clear the filter.", "请尝试其他搜索词，或清空筛选。") : t("No weekly rows reported for this period.", "所选区间尚无周汇总记录。")}</td></tr>}
    </MetricTable>
  </div>;
}
