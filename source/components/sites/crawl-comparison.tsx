"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { ComparisonField, CrawlComparisonResponse, PageDifference, SchemaSummary } from "@/lib/seo/crawl-comparison";

const control = "rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text-strong disabled:opacity-50";
const PER_PAGE = 20;

export function CrawlComparison({ siteId }: { siteId: string }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<CrawlComparisonResponse | null>(null);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController(); requestRef.current?.abort(); requestRef.current = controller;
    setLoading(true); setError(false); setData(null);
    fetch(`/api/sites/${encodeURIComponent(siteId)}/crawl-comparison`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); const result = await response.json() as CrawlComparisonResponse; if (result.siteId !== siteId) throw new Error(); return result; })
      .then(result => { if (!controller.signal.aborted) { setData(result); setAfterId(result.crawls[0]?.id ?? ""); setBeforeId(result.crawls[1]?.id ?? ""); setPage(0); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); requestRef.current?.abort(); };
  }, [expanded, siteId, revision]);
  async function compare() {
    const controller = new AbortController(); requestRef.current?.abort(); requestRef.current = controller;
    setLoading(true); setError(false); setData(current => current ? { ...current, comparison: null } : null);
    try {
      const params = new URLSearchParams({ beforeId, afterId });
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/crawl-comparison?${params}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error();
      const result = await response.json() as CrawlComparisonResponse;
      if (result.siteId !== siteId) throw new Error();
      if (!controller.signal.aborted) { setData(result); setPage(0); }
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function clearResult() { requestRef.current?.abort(); setLoading(false); setData(current => current ? { ...current, comparison: null } : null); setError(false); setPage(0); }
  const date = (value: string) => new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const statusLabel = (status: PageDifference["status"]) => ({ CHANGED: t("Changed fields", "字段有变化"), UNCHANGED: t("Compared fields unchanged", "已比字段未变"), ONLY_BEFORE: t("Observed only before", "仅前次观察到"), ONLY_AFTER: t("Observed only after", "仅后次观察到"), AMBIGUOUS: t("Ambiguous records", "记录无法确定") })[status];
  const fieldLabel = (field: ComparisonField) => ({ title: t("Title", "标题"), description: t("Description", "描述"), canonical: t("Canonical", "规范网址"), statusCode: "HTTP", indexable: t("No noindex observed", "未发现 noindex"), robotsMeta: "Robots meta", xRobotsTag: "X-Robots-Tag", noindexSource: t("noindex source", "noindex 来源"), schema: "Schema" })[field];
  const value = (item: string | number | boolean | null) => item === null ? t("Not recorded", "未记录") : item === "" ? t("Empty text", "空文本") : typeof item === "boolean" ? item ? t("Yes", "是") : t("No", "否") : String(item);
  const result = data?.comparison;
  const rows = result?.rows.filter(row => filter === "ALL" || row.status === filter) ?? [];
  const shown = rows.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const before = data?.crawls.find(crawl => crawl.id === beforeId), after = data?.crawls.find(crawl => crawl.id === afterId);
  const ordered = !!before && !!after && new Date(before.finishedAt).getTime() < new Date(after.finishedAt).getTime();
  return <section className="panel overflow-hidden" aria-label={t("Crawl comparison", "抓取前后对比")}>
    <button type="button" className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left" aria-expanded={expanded} onClick={() => setExpanded(open => !open)}><span className="flex items-center gap-2 font-semibold text-text-strong"><ArrowLeftRight size={18} />{t("Compare saved crawls", "对比两次已保存的抓取")}</span><ChevronDown size={18} className={expanded ? "rotate-180" : ""} /></button>
    {expanded && <div className="space-y-4 border-t border-border p-5">
      <p className="text-[13px] leading-6 text-muted-foreground">{t("Compare technical fields recorded at two times. Uses local saved data only, without crawling again or using model allowance. Changes do not establish ranking or traffic improvement.", "对比两个时间点记录的技术字段。只读取本地已保存数据，不重新抓取、不消耗模型额度。字段变化不能证明排名或流量提升。")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]"><span>{t("Before crawl", "修改前的抓取")}</span><select className={control} value={beforeId} disabled={loading} onChange={event => { clearResult(); setBeforeId(event.target.value); }}><option value="">{t("Choose a crawl", "选择抓取记录")}</option>{data?.crawls.map(crawl => <option key={crawl.id} value={crawl.id}>{date(crawl.finishedAt)} · {crawl.storedPages} {t("pages", "页")}</option>)}</select></label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]"><span>{t("After crawl", "修改后的抓取")}</span><select className={control} value={afterId} disabled={loading} onChange={event => { clearResult(); setAfterId(event.target.value); }}><option value="">{t("Choose a crawl", "选择抓取记录")}</option>{data?.crawls.map(crawl => <option key={crawl.id} value={crawl.id}>{date(crawl.finishedAt)} · {crawl.storedPages} {t("pages", "页")}</option>)}</select></label>
        <button type="button" className={control} disabled={loading || !ordered} onClick={() => void compare()}>{loading ? t("Loading…", "读取中…") : t("Compare", "开始对比")}</button>
        <button type="button" className={control} disabled={loading} onClick={() => setRevision(v => v + 1)} aria-label={t("Refresh crawl history", "刷新抓取记录")}><RefreshCw size={16} /></button>
      </div>
      {data && <p className="text-[12px] text-muted-foreground">{t("Choose from the latest {limit} completed crawls. Before must be older than after.", "可选择最近 {limit} 次已完成抓取，前次时间必须早于后次。", { limit: data.crawlListLimit })}</p>}
      {data && data.crawls.length < 2 && <p className="text-[13px] text-muted-foreground">{t("Two completed crawls are needed. The current snapshot remains available; run a new crawl after making website changes.", "需要两次已完成抓取。当前快照会保留，可在网站修改后再进行一次抓取。")}</p>}
      {error && <p role="alert" className="text-[13px] text-danger">{t("Comparison could not be loaded. Refresh the records and select two completed crawls from this site in chronological order.", "无法读取对比。请刷新记录，按先后顺序选择此站点的两次已完成抓取。")}</p>}
      {result && <>
        <div className="grid gap-3 md:grid-cols-2">{(["before", "after"] as const).map(side => { const snapshot = result[side]; return <div key={side} className="rounded-xl border border-border p-4 text-[13px] leading-6"><strong>{side === "before" ? t("Before", "前次") : t("After", "后次")} · {date(snapshot.finishedAt)}</strong><p>{t("Compared {loaded} / {stored} saved pages", "参与对比 {loaded} / {stored} 个已存页面", { loaded: snapshot.loadedPages, stored: snapshot.storedPages })}</p><p>{t("Visible findings: {visible}; of these, unverified: {unverified}. Reviewed exclusions: {excluded}.", "可见问题 {visible} 条，其中待核实 {unverified} 条；已复核排除 {excluded} 条。", snapshot.issues)}</p>{(snapshot.sampleLimited || snapshot.truncated) && <p className="text-warning">{t("Limited sample; the whole site is not represented.", "样本有限，不代表全站。")}</p>}</div>; })}</div>
        <p className="text-[12px] leading-6 text-muted-foreground">{t("Up to {limit} pages per crawl, ordered by exact stored URL. Protocol, www, slash and query differences remain separate. A URL missing from one sample is unknown, not evidence of deletion or a fix. Finding counts use the current reviewed filter across each saved crawl and may reflect different coverage or review policies.", "每次最多读取 {limit} 页，按原始网址排序。协议、www、斜杠及查询参数不同的网址分别处理。某次样本没有该网址表示情况未知，不代表页面删除或问题修复。问题总数按当前复核过滤规则统计各次已存抓取，可能受覆盖范围或复核规则影响。", { limit: result.pageLimit })}</p>
        <div className="flex flex-wrap gap-3 text-[12px]">{(Object.keys(result.totals) as PageDifference["status"][]).map(status => <span key={status} className="rounded-md bg-bg-soft px-3 py-2">{statusLabel(status)} {result.totals[status]}</span>)}</div>
        <label className="flex items-center gap-2 text-[13px]">{t("Show pages", "筛选页面")}<select className={control} value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="ALL">{t("All", "全部")}</option>{(Object.keys(result.totals) as PageDifference["status"][]).map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
        <div className="space-y-3">{shown.map(row => <details key={row.url} className="rounded-xl border border-border p-4"><summary className="cursor-pointer break-all text-[13px] leading-6 text-text-strong"><span className="mr-3 text-link">{statusLabel(row.status)}</span>{row.url}</summary>
          {row.status === "ONLY_AFTER" || row.status === "ONLY_BEFORE" ? <p className="mt-3 text-[13px] text-muted-foreground">{t("The other sample has no matching record. The live page status is unknown.", "另一次样本没有对应记录，当前网站页面状态未知。")}</p> : row.status === "AMBIGUOUS" ? <p className="mt-3 text-[13px] text-muted-foreground">{t("Duplicate records prevent a unique pairing for this URL.", "此网址存在重复记录，无法唯一配对。")}</p> : <>
            {row.changes.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] table-fixed text-left text-[12px]"><thead><tr><th className="w-28 p-2">{t("Field", "字段")}</th><th className="p-2">{t("Before", "前次")}</th><th className="p-2">{t("After", "后次")}</th></tr></thead><tbody>{row.changes.map(change => <tr key={change.field} className="border-t border-border align-top"><th className="p-2">{fieldLabel(change.field)}</th><td className="break-all whitespace-pre-wrap p-2">{value(change.before)}</td><td className="break-all whitespace-pre-wrap p-2">{value(change.after)}{change.previewTruncated && <p className="mt-1 text-muted-foreground">{t("Long values shown as excerpts.", "长字段仅展示节选。")}</p>}</td></tr>)}</tbody></table></div>}
            {!row.changes.length && <p className="mt-3 text-[13px] text-muted-foreground">{t("The compared HTTP and metadata fields are unchanged. Article text and unrecorded fields are not compared.", "本次对比的 HTTP 和元数据字段未变。正文及未记录字段不在对比范围内。")}</p>}
            <div className="mt-3 grid gap-3 md:grid-cols-2"><SchemaSide label={t("Before Schema", "前次 Schema")} schema={row.schema.before} /><SchemaSide label={t("After Schema", "后次 Schema")} schema={row.schema.after} /></div>
            <p className="mt-2 text-[12px] text-muted-foreground">{row.schema.comparison === "UNKNOWN" ? t("Schema differences cannot be established because at least one check is missing or partial.", "至少一侧检查缺失或不完整，无法确定 Schema 差异。") : row.schema.comparison === "CHANGED" ? t("Recorded schema types or finding categories changed. Review the page facts before treating a finding as fixed.", "已记录的 Schema 类型或问题分类有变化，仍需核实页面事实后判断是否修复。") : t("Recorded schema summaries match. This is not a complete schema or rich-result validation.", "已记录的 Schema 摘要一致，不代表通过完整标记或富媒体结果验证。")}</p>
          </>}
        </details>)}</div>
        {!shown.length && <p className="text-[13px] text-muted-foreground">{t("No matching page records in this comparison sample.", "此对比样本没有符合条件的页面记录。")}</p>}
        <div className="flex items-center gap-3 text-[13px]"><button className={control} type="button" disabled={page === 0} onClick={() => setPage(n => n - 1)}>{t("Previous", "上一页")}</button><span>{rows.length ? page + 1 : 0} / {Math.ceil(rows.length / PER_PAGE)}</span><button className={control} type="button" disabled={(page + 1) * PER_PAGE >= rows.length} onClick={() => setPage(n => n + 1)}>{t("Next", "下一页")}</button><span>{t("{count} rows in the sample", "样本共 {count} 条", { count: rows.length })}</span></div>
      </>}
    </div>}
  </section>;
}

function SchemaSide({ label, schema }: { label: string; schema: SchemaSummary | null }) {
  const { t } = useI18n();
  return <div className="rounded-lg bg-bg-soft p-3 text-[12px] leading-5"><strong>{label}</strong>{!schema || schema.state === "UNKNOWN" ? <p>{t("Not checked", "尚未检查")}</p> : <><p>{schema.state === "PARTIAL" ? t("Partial check", "部分检查") : t("Saved sample checked", "已检查保存的样本")} · JSON-LD {schema.parsed}/{schema.blocks}</p><p className="break-all">{schema.types.join(", ") || t("No recognized types", "未识别类型")}</p>{schema.findings.map((finding, index) => <p key={index} className="break-all">{finding}</p>)}{schema.detailsLimited && <p>{t("Summary truncated", "摘要已截断")}</p>}</>}</div>;
}
