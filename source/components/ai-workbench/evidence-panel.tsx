"use client";

import { useEffect, useState } from "react";
import { FileSearch, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { localizedObservation } from "@/lib/i18n/audit";
import type { DiagnosticEvidence, DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";
import { isStructuredDataReport, type StructuredDataReport } from "@/lib/seo/structured-data";
import type { TaskDiagnosticEvidence, TaskKind, WorkbenchData } from "./model";
import s from "./workbench.module.css";

export function EvidencePanel({ siteId, selection, pages, onSelection, onUse, disabled }: {
  siteId: string; selection: DiagnosticSelection; pages: WorkbenchData["pages"];
  onSelection: (selection: DiagnosticSelection) => void;
  onUse: (evidence: DiagnosticEvidence, kind: TaskKind) => void; disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const [evidence, setEvidence] = useState<DiagnosticEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [lookup, setLookup] = useState("");
  const selectionKey = JSON.stringify(selection);
  useEffect(() => {
    const selected = JSON.parse(selectionKey) as DiagnosticSelection;
    setEvidence(null); setError(null);
    if (!selected.pageId && !selected.url && !selected.query) { setLoading(false); return; }
    const controller = new AbortController();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(selected)) if (typeof value === "string" && value) params.set(key, value);
    setLoading(true);
    void fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant/evidence?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || "evidence_failed"); if (value.siteId !== siteId) throw new Error("evidence_mismatch"); return value as DiagnosticEvidence; })
      .then(value => { if (!controller.signal.aborted) setEvidence(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "evidence_failed"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [siteId, selectionKey, revision]);
  const selectedUrl = evidence?.page?.url ?? evidence?.selection.url;
  const dateText = (date: string) => new Date(date).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const selectedPages = pages.some(page => page.id === selection.pageId) || !evidence?.page ? pages : [...pages, { id: evidence.page.id, url: evidence.page.url, title: evidence.page.title, hasBody: evidence.page.body.length >= 100 }];
  return <section className={s.evidencePanel} aria-labelledby="evidence-title">
    <header className={s.evidenceHeading}><div><FileSearch size={21} /><div><h2 id="evidence-title">{t("Page evidence", "单页诊断依据")}</h2><p>{t("Review saved page and search data before generating a draft. This preview uses no model allowance.", "先查看已保存的页面与搜索数据，再生成草稿。预览不消耗模型额度。")}</p></div></div><button className={s.reviewButton} type="button" disabled={loading || (!selection.pageId && !selection.url && !selection.query)} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />{t("Refresh evidence", "刷新依据")}</button></header>
    <div className={s.evidenceBody}>
      <div className={s.evidencePicker}><label className={s.field}><span>{t("Choose a crawled page", "选择已抓取页面")}</span><select value={selection.pageId ?? ""} onChange={event => onSelection(event.target.value ? { pageId: event.target.value } : {})}><option value="">{t("Choose a page", "请选择页面")}</option>{selectedPages.map(page => <option key={page.id} value={page.id}>{page.title || page.url}</option>)}</select></label>
      <form onSubmit={event => { event.preventDefault(); if (lookup.trim()) onSelection({ url: lookup.trim() }); }}><label className={s.field}><span>{t("Or find a saved page URL", "或查找已保存的网址")}</span><div className={s.evidenceLookup}><input value={lookup} onChange={event => setLookup(event.target.value)} maxLength={2048} type="url" placeholder="https://example.com/article" /><button type="submit" className={s.reviewButton} disabled={!lookup.trim()}>{t("Look up", "查找")}</button></div></label></form></div>
      {selection.query && <p className={s.evidenceSource}>{t("Selected query", "来源查询")}：<strong>{selection.query}</strong></p>}
      {loading && <p role="status" className={s.sourceHint}>{t("Loading saved evidence…", "正在读取已保存依据…")}</p>}
      {error && <p role="alert" className={s.validation}>{t("Evidence could not be loaded. Choose a page from this site's saved crawl or GSC data, then retry.", "无法读取依据。请选择此站点已抓取或 GSC 已记录的页面后重试。")}</p>}
      {!loading && !error && !evidence && <p className={s.sourceHint}>{t("Choose a saved page, or open a task from Opportunities. This does not start a new crawl.", "选择已保存页面，或从“优化机会”进入。这里不会发起新的抓取。")}</p>}
      {evidence && <>
        {evidence.limits && <p className={s.sourceHint}>{t("Preview limits: {pages} query-page candidates, {issues} audit findings, {chars} source characters.", "预览范围：最多 {pages} 个查询候选页面、{issues} 条审计问题、{chars} 字符原文节选。", { pages: evidence.limits.queryCandidates, issues: evidence.limits.auditIssues, chars: evidence.limits.bodyCharacters })}{(evidence.limits.queryCandidatesAtLimit || evidence.limits.auditIssuesAtLimit) && <> {t("A sample limit was reached; more records may exist.", "已达到样本上限，可能还有未展示的记录。")}</>}</p>}
        {!selectedUrl && <div><p className={s.sourceHint}>{t("Choose the page to work on. Up to 50 saved query-page matches are shown; this is a sample, not every page on the site.", "请选择要处理的页面。最多展示 50 条已保存的查询与页面对应记录；这是样本，不代表全站所有页面。")}</p><div className={s.candidateList}>{evidence.pages.map(page => <button type="button" key={page.url} onClick={() => onSelection({ query: selection.query, opportunity: selection.opportunity, url: page.url, ...(page.id ? { pageId: page.id } : {}) })}><strong>{page.title || page.url}</strong><span>{page.url}</span></button>)}</div>{!evidence.pages.length && <p className={s.validation}>{t("No saved page mapping is available for this query. Sync GSC query-page details or choose a crawled page.", "此查询暂无已保存的页面对应关系。请同步 GSC 查询与页面明细，或选择已抓取页面。")}</p>}</div>}
        {selectedUrl && <>
          <p className={s.evidenceSource}>{selectedUrl}</p>
          <p className={s.sourceHint}>{evidence.crawl?.finishedAt ? t("Crawl saved: {date}", "抓取保存时间：{date}", { date: dateText(evidence.crawl.finishedAt) }) : t("No completed crawl evidence", "暂无已完成的抓取依据")}{evidence.crawl?.sampleLimited && <> · {t("Limited crawl sample", "抓取为有限样本")}</>}</p>
          <FocusedQueryEvidence evidence={evidence.queryEvidence} />
          {evidence.page ? <dl className={s.evidenceFacts}><div><dt>{t("Page title", "页面标题")}</dt><dd>{evidence.page.title || t("Not found", "未发现")}</dd></div><div><dt>HTTP</dt><dd>{evidence.page.statusCode ?? t("Unknown", "未知")}</dd></div><div><dt>{t("Index directive", "索引指令")}</dt><dd>{evidence.page.indexable ? t("No noindex observed; indexing is unconfirmed", "未发现 noindex；是否收录尚未确认") : t("noindex observed", "发现 noindex")}</dd></div><div><dt>{t("Canonical URL", "规范网址")}</dt><dd>{evidence.page.canonical || t("Not found", "未发现")}</dd></div><div><dt>{t("Meta description", "页面描述")}</dt><dd>{evidence.page.description || t("Not found", "未发现")}</dd></div></dl> : <p className={s.validation}>{t("This URL has saved search evidence, but no page body in the latest crawl. Page-level checks and rewriting need a new crawl or pasted text.", "此网址有搜索记录，但最近抓取没有页面正文。页面检查和改写需要重新抓取或补充原文。")}</p>}
          <details className={s.evidenceDetail} open><summary>{t("Search evidence", "搜索表现依据")}</summary><p className={s.sourceHint}>{evidence.searchEvidence.period.start} → {evidence.searchEvidence.period.end} · {t("Saved GSC data; query lists are samples", "已保存 GSC 数据；查询列表为样本")}</p>{evidence.searchEvidence.pages.filter(page => page.url === selectedUrl).map(page => <div key={page.url}><div className={s.evidenceMetrics}><span>{t("Clicks", "点击量")}<strong>{page.clicks ?? t("Unknown", "未知")}</strong></span><span>{t("Impressions", "曝光量")}<strong>{page.impressions ?? t("Unknown", "未知")}</strong></span></div>{page.status !== "REPORTED" && <p className={s.sourceHint}>{page.status === "UNKNOWN" ? t("The period is incomplete; missing data is not zero.", "周期数据不完整，缺失不代表零。") : t("No recorded page rows for this period; this is not proof of zero traffic.", "本周期未记录该页面数据，不代表没有流量。")}</p>}{page.queries.length > 0 && <div className={s.evidenceTableWrap}><table className={s.evidenceTable}><thead><tr><th>{t("Query", "查询")}</th><th>{t("Clicks", "点击")}</th><th>{t("Impressions", "曝光")}</th></tr></thead><tbody>{page.queries.map(query => <tr key={query.query}><td>{query.query}</td><td>{query.clicks}</td><td>{query.impressions}</td></tr>)}</tbody></table></div>}{page.queryStatus !== "REPORTED_SAMPLE" && <p className={s.sourceHint}>{t("No complete query sample is available for this page.", "此页面暂无完整可用的查询样本。")}</p>}</div>)}</details>
          <details className={s.evidenceDetail}><summary>{t("Saved audit observations", "已保存的审计发现")} · {evidence.issues.length}</summary><p className={s.sourceHint}>{t("Up to 30 saved findings are shown for this page. This is a sample, not a complete page or site audit.", "最多展示该页面的 30 条已保存问题，这是样本，不代表页面或全站的完整审计。")}</p>{evidence.issues.map((issue, i) => <div key={i} className={s.evidenceIssue}><span>{issue.disposition === "unverified" ? t("Needs verification", "待核实") : t("Observed", "已观察")}</span><p>{localizedObservation(issue.message, locale)}</p></div>)}{!evidence.issues.length && <p className={s.sourceHint}>{t("No saved findings in this sample. This does not certify the page is issue-free.", "此样本没有已保存的问题，不能据此认定页面完全无问题。")}</p>}</details>
          <SchemaEvidence report={evidence.schemaReport} />
          {evidence.page?.body && <details className={s.evidenceDetail}><summary>{t("Captured source text", "已抓取原文")}</summary><p className={s.sourceHint}>{t("The source below is the saved excerpt, limited to 12,000 characters. It is not proof of the full article. Paste the full source in the task if needed; pasted text takes precedence.", "下方是已保存的原文节选，最多 12,000 字符，不能据此认定已取得全文。需要全文时请在任务中补充，粘贴文字优先使用。")}</p><pre className={s.evidenceText}>{evidence.page.body}</pre></details>}
          <div className={s.evidenceActions}><button type="button" className={s.reviewButton} disabled={disabled} onClick={() => onUse(evidence, "SEO_FIX_PLAN")}>{t("Use for a fix plan", "带入修复方案")}</button><button type="button" className={s.reviewButton} disabled={disabled || !evidence.page || evidence.page.body.length < 100} onClick={() => onUse(evidence, "REWRITE_ARTICLE")}>{t("Use for paragraph edits", "带入逐段改稿")}</button><span>{t("Review the task below, then click Generate.", "带入后检查下方任务，再点击生成。")}</span></div>
        </>}
      </>}
    </div>
  </section>;
}

function SchemaEvidence({ report }: { report: unknown }) {
  const { t, locale } = useI18n();
  const data: StructuredDataReport | null = isStructuredDataReport(report) ? report : null;
  return <details className={s.evidenceDetail} open><summary>{t("Structured data checks", "Schema 结构化数据检查")}</summary>
    {!data ? <p className={s.sourceHint}>{t("Not checked in this saved crawl. Run a new crawl to collect structured data evidence.", "这次保存的抓取尚未检查。请重新抓取，以收集结构化数据依据。")}</p> : <>
      <p className={s.sourceHint}>{t("{parsed}/{total} JSON-LD blocks parsed", "已解析 {parsed}/{total} 个 JSON-LD 数据块", { parsed: data.parsedBlocks, total: data.jsonLdBlocks })} · {data.coverage === "PARTIAL" || data.truncated ? t("Partial check; some content was not checked", "部分检查；有内容未检查") : t("Saved sample checked", "已检查保存的样本")}</p>
      <p className={s.sourceHint}>{t("Syntax and selected field checks only. Author identity, prices, page consistency and rich-result eligibility still need review. This does not change your health score.", "这里检查语法及部分字段。作者身份、价格、与正文的一致性及富媒体结果资格仍需核实，不影响现有健康分。")}</p>
      {data.entities.length > 0 && <p className={s.evidenceSource}>{[...new Set(data.entities.flatMap(entity => entity.types))].join(" · ")}</p>}
      {data.findings.map((finding, i) => <div key={i} className={s.evidenceIssue}><span>{finding.severity === "ERROR" ? t("Error", "错误") : finding.severity === "WARNING" ? t("Review", "需检查") : t("Information", "提示")}</span><strong>{schemaExplanation(finding.code, locale, finding.expected)}</strong><code>{finding.path}</code><pre>{finding.observed}</pre></div>)}
      {!data.findings.length && <p className={s.sourceHint}>{t("No problems found by these checks. This is not a full schema or rich-result certification.", "当前检查未发现问题，不代表通过完整 Schema 或富媒体结果认证。")}</p>}
      {data.otherMarkup && <p className={s.sourceHint}>{t("Other structured markup was detected but not validated.", "检测到其他格式的结构化标记，尚未校验。")}</p>}
    </>}
  </details>;
}

function schemaExplanation(code: string, locale: string, fallback: string) {
  const labels: Record<string, string> = {
    NO_JSON_LD: "捕获的 HTML 未发现 JSON-LD；请结合页面用途决定是否添加",
    JSON_INVALID: "JSON-LD 语法不合法，请检查括号、引号及逗号",
    JSON_ROOT_INVALID: "JSON-LD 顶层结构不符合本次检查支持的格式",
    TYPE_MISSING: "未识别实体类型，请检查 @type",
    TYPE_INVALID: "实体类型格式需要检查",
    CONTEXT_MISSING: "缺少上下文定义，请检查 @context",
    CONTEXT_UNSUPPORTED: "此上下文尚未验证，不能判定其字段含义",
    FIELD_RECOMMENDED: "建议补充与页面内容一致的字段",
    FIELD_TYPE_INVALID: "字段的数据格式需要检查",
    URL_REVIEW: "网址格式需要检查",
    DATE_REVIEW: "日期格式需要检查",
    PAGE_TITLE_DIFFERENCE: "标题与页面信息存在差异，请核对是否合理",
    PAGE_URL_DIFFERENCE: "标记网址与页面存在差异，请核对是否合理",
    PRODUCT_SNIPPET_ELIGIBILITY: "产品搜索展示所需信息可能不完整，请核实实际产品资料",
    BREADCRUMB_ELIGIBILITY: "面包屑导航结构需要检查",
    REFERENCE_NOT_RESOLVED: "此实体使用引用，当前检查未展开核实",
    OTHER_MARKUP_NOT_CHECKED: "检测到其他结构化标记格式，当前未校验",
    LIMIT_REACHED: "内容超过本次检查范围，部分内容未检查",
  };
  return locale === "zh" ? labels[code] ?? `请核对字段（${code}）：${fallback}` : fallback;
}

export function TaskEvidence({ evidence }: { evidence: TaskDiagnosticEvidence }) {
  const { t } = useI18n();
  return <details className={s.evidenceDetail}><summary>{t("Evidence saved with this task", "此任务提交时的依据")}</summary><p className={s.sourceHint}>{t("This snapshot belongs to this task; refreshing the preview above does not change it.", "这是本任务的依据快照；刷新上方预览不会改动它。")}</p><p className={s.evidenceSource}>{evidence.page?.url ?? evidence.selection.url}</p><p className={s.sourceHint}>{t("Crawl time", "抓取时间")}：{evidence.crawl?.finishedAt ?? t("Unknown", "未知")}</p><p className={s.sourceHint}>GSC：{evidence.searchEvidence.period.start} → {evidence.searchEvidence.period.end}</p><FocusedQueryEvidence evidence={evidence.queryEvidence} />{evidence.searchEvidence.pages.map(page => <p className={s.sourceHint} key={page.url}>{page.url}<br />{t("Clicks", "点击")}：{page.clicks ?? t("Unknown", "未知")} · {t("Impressions", "曝光")}：{page.impressions ?? t("Unknown", "未知")}</p>)}<SchemaEvidence report={evidence.schemaReport} /></details>;
}

function FocusedQueryEvidence({ evidence }: { evidence: DiagnosticEvidence["queryEvidence"] | undefined }) {
  const { t } = useI18n();
  if (!evidence) return null;
  return <div className={s.focusedQuery}><p>{t("Selected query on this page", "此页面的所选查询")}：<strong>{evidence.query}</strong></p><div className={s.evidenceMetrics}><span>{t("Clicks", "点击")}<strong>{evidence.clicks ?? t("Unknown", "未知")}</strong></span><span>{t("Impressions", "曝光")}<strong>{evidence.impressions ?? t("Unknown", "未知")}</strong></span><span>{t("CTR", "点击率")}<strong>{evidence.ctr === null ? t("Unknown", "未知") : `${(evidence.ctr * 100).toFixed(2)}%`}</strong></span><span>{t("Average position", "平均排名")}<strong>{evidence.position?.toFixed(1) ?? t("Unknown", "未知")}</strong></span></div>{evidence.status !== "REPORTED" && <p className={s.sourceHint}>{t("Insufficient recorded data for this query and page. Missing values are not zero.", "此查询与页面的已记录数据不足，缺失不代表零。")}</p>}</div>;
}
