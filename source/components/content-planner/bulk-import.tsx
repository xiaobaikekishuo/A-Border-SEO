"use client";

import { useI18n } from "@/lib/i18n/client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FileDown, Info, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { Modal } from "./planner-ui";
import { getPlannerLabels, safeSiteUrl, shortDate, type Funnel, type Pillar } from "./model";
import type { Mutation } from "./planner-forms";
import { BULK_LIMIT, addLimitedSelection, draftFromPage, importPayload, importSkipReason, type ImportDraft, type ImportResult, type InventoryPage, type PageInventory } from "./bulk-model";
import { plannerApiError } from "./api-messages";
import s from "./planner.module.css";
import b from "./bulk.module.css";

type Submit = (mutation: Mutation) => Promise<Record<string, unknown> | null>;
export function BulkImport({ siteId, domain, pillars, initialPillarId, busy, error, onSubmit, onClose, onCreatePillar, onComplete, initialPages }: {
  siteId: string; domain: string; pillars: Pillar[]; initialPillarId?: string; busy: boolean; error: string | null;
  onSubmit: Submit; onClose: () => void; onCreatePillar: () => void; onComplete: (pillarId: string, result: ImportResult) => void;
  initialPages?: PageInventory;
}) {
  const { t } = useI18n();
  const [inventory, setInventory] = useState<PageInventory | null>(initialPages ?? null);
  const [loading, setLoading] = useState(!initialPages);
  const [readError, setReadError] = useState<string | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [request, setRequest] = useState({ query: "", page: 1, articlesOnly: true });
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<"select" | "preview" | "result">("select");
  const [pillarId, setPillarId] = useState(initialPillarId ?? "");
  const [batchFunnel, setBatchFunnel] = useState<Funnel>("TOFU");
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (step !== "select") return;
    const controller = new AbortController();
    async function load() {
      setLoading(true); setReadError(null);
      try {
        const query = new URLSearchParams({ query: request.query, page: String(request.page), pageSize: "25", articlesOnly: String(request.articlesOnly) });
        const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/content/pages?${query}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || t("Could not load the crawl inventory. Please retry.", "读取抓取库存失败，请重试。"));
        if (body.siteId !== siteId) throw new Error(t("The returned inventory belongs to another site. Refresh and retry.", "返回的库存不属于当前站点，请刷新后重试。"));
        if (!controller.signal.aborted) setInventory(body as PageInventory);
      } catch (cause) {
        if (!controller.signal.aborted) setReadError(cause instanceof Error ? cause.message : t("Could not load data. Please retry.", "读取失败，请重试。"));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [siteId, request, revision, step, t]);

  const selected = useMemo(() => new Set(drafts.map(draft => draft.pageId)), [drafts]);
  const selectableRows = (inventory?.rows ?? []).filter(row => !row.existingClusterId && safeSiteUrl(row.url, domain));
  const errorMessage = error || readError;
  function addPages(pages: InventoryPage[]) {
    const eligible = pages.filter(page => !page.existingClusterId && safeSiteUrl(page.url, domain));
    const merged = addLimitedSelection(drafts.map(draft => draft.pageId), eligible.map(page => page.id));
    const old = new Map(drafts.map(draft => [draft.pageId, draft]));
    const incoming = new Map(eligible.map(page => [page.id, page]));
    setDrafts(merged.ids.map(id => old.get(id) ?? draftFromPage(incoming.get(id)!, batchFunnel)));
    setNotice(merged.omitted ? t("Each batch allows up to {v0} items; {v1} additional items were not selected. Process this batch first.", "每批最多 {v0} 条，另有 {v1} 条未勾选。可先处理当前批次。", { v0: BULK_LIMIT, v1: merged.omitted }) : null);
  }
  function updateDraft(id: string, changes: Partial<ImportDraft>) { setDrafts(previous => previous.map(draft => draft.pageId === id ? { ...draft, ...changes } : draft)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!drafts.length || !pillarId) return;
    const response = await onSubmit(importPayload(pillarId, drafts));
    if (!response) return;
    if (typeof response.imported !== "number" || typeof response.skipped !== "number" || !Array.isArray(response.results)) {
      setReadError(t("The server responded with incomplete results. Reload the planner to check before submitting again.", "服务器已响应，但结果信息不完整。请重新读取内容规划确认，勿直接重复提交。")); return;
    }
    setResult(response as ImportResult); setStep("result"); setReadError(null);
  }
  return <Modal wide title={t("Import existing articles", "导入已有文章")} eyebrow={t("EXISTING CONTENT · Manual organization", "EXISTING CONTENT · 人工归类")} description={t("Select pages from this site's latest completed crawl. This updates local planning only; published content stays unchanged.", "从当前站点最近一次已完成抓取中选择页面；只更新本地内容规划，不修改远程正文。")} onClose={busy ? () => {} : onClose}>
    <ol className={b.steps} aria-label={t("Import steps", "导入步骤")}><li aria-current={step === "select" ? "step" : undefined}>{t("1 · Select existing pages", "1 · 选择已有页面")}</li><li aria-current={step === "preview" ? "step" : undefined}>{t("2 · Confirm pillar and categories", "2 · 确认主题与分类")}</li><li aria-current={step === "result" ? "step" : undefined}>{t("3 · Review item results", "3 · 查看逐项结果")}</li></ol>
    {errorMessage && <div role="alert" className={`${s.notice} ${s.noticeError}`}><Info size={17} /><div>{plannerApiError(errorMessage, t)}<p>{t("Your page selections and edits are preserved.", "已选页面和编辑内容仍然保留。")}</p>{step === "select" && <button className={s.textButton} onClick={() => setRevision(value => value + 1)}>{t("Reload inventory", "重新读取库存")}</button>}</div></div>}
    {step === "select" && <>
      {!pillars.length && <div className={s.notice}><Info size={17} /><div>{t("Create a pillar first, then return to import articles. No demo data is added automatically.", "还没有总览主题。请先新建一个主题，再回来导入文章；不会自动创建演示数据。")}<div className={b.inlineAction}><button className={s.secondary} onClick={onCreatePillar}><Plus size={15} />{t("Create a pillar first", "先新建主题")}</button></div></div></div>}
      {inventory?.crawl && <div className={b.inventoryInfo}><Info size={16} /><p>{t("Inventory: ", "库存：")}{inventory.crawl.finishedAt ? shortDate(inventory.crawl.finishedAt, t) : t("Date not recorded", "日期未记录")} {t("· Crawled ", "· 已抓取")} {inventory.crawl.pagesFound} {t(" pages", "页")}{inventory.crawl.sampleLimited ? t(" · Limit: {v0} pages. This is a limited sample, not a full article inventory.", " · 上限 {v0} 页。本次是有限样本，不是全站文章清单。", { v0: inventory.crawl.maxPages }) : t(". Only pages saved by this crawl are listed.", "。仅列出此次抓取已保存的页面。")}</p></div>}
      <form className={b.inventorySearch} onSubmit={event => { event.preventDefault(); setRequest(previous => ({ ...previous, query: queryInput.trim(), page: 1 })); }}><label className={s.search}><Search size={16} /><input aria-label={t("Search inventory by title or URL", "搜索库存标题或 URL")} placeholder={t("Search title or URL…", "搜索标题或 URL…")} value={queryInput} onChange={event => setQueryInput(event.target.value)} /></label><button className={s.secondary} disabled={loading}>{t("Search", "搜索")}</button><button type="button" className={s.iconButton} aria-label={t("Refresh crawl inventory", "刷新抓取库存")} onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw size={16} className={loading ? s.spin : ""} /></button></form>
      <div className={b.inventoryOptions}><label className={s.checkboxLabel}><input type="checkbox" checked={request.articlesOnly} onChange={event => setRequest(previous => ({ ...previous, articlesOnly: event.target.checked, page: 1 }))} />{t("Article candidates only", "仅文章候选")}</label><span>{t("Detected by page rules, not AI. Uncheck to see all pages.", "页面规则识别，非 AI；取消勾选可查看全部页面。")}</span></div>
      <div className={b.selectionSummary}><span>{t("Selected ", "已勾选")} <strong>{drafts.length}</strong> / {BULK_LIMIT} {t(" items · Selections persist across pages and searches", "条 · 翻页和搜索保留勾选")}</span><div><button className={s.textButton} disabled={loading || !selectableRows.length} onClick={() => addPages(selectableRows)}>{t("Select importable items on this page", "勾选本页可导入项")}</button><button className={s.textButton} disabled={!drafts.length} onClick={() => { setDrafts([]); setNotice(null); }}>{t("Clear selection", "清空勾选")}</button></div></div>
      {notice && <p role="status" className={b.warning}>{notice}</p>}
      {loading ? <div className={b.loading}><Loader2 className={s.spin} size={23} />{t("Loading saved pages…", "正在读取已保存的页面…")}</div> : !inventory && readError ? <div className={b.empty}><Info size={26} /><h3>{t("Inventory is temporarily unavailable", "暂时无法读取库存")}</h3><p>{t("Use the reload button above. Your selected pages are preserved.", "请使用上方的重新读取按钮。已选页面仍然保留。")}</p></div> : !inventory?.crawl ? <div className={b.empty}><FileDown size={30} /><h3>{t("No completed crawl inventory yet", "暂无已完成的抓取库存")}</h3><p>{t("Complete a crawl in Crawl / Audit, then return to select existing articles.", "请先到“Crawl / Audit”完成一次抓取，再回来选择已有文章。")}</p><a href={`/sites/${encodeURIComponent(siteId)}/crawl`} className={s.secondary}>{t("Open Crawl / Audit", "查看抓取页面")}<ArrowRight size={15} /></a></div> : !inventory.rows.length ? <div className={b.empty}><Search size={26} /><h3>{t("No matching pages", "没有符合条件的页面")}</h3><p>{t("Try a shorter search, or uncheck Article candidates only to see all pages.", "试试更短的关键词，或取消“仅文章候选”查看全部页面。")}</p></div> : <ul className={b.inventoryList}>{inventory.rows.map(row => {
        const href = safeSiteUrl(row.url, domain);
        const checked = selected.has(row.id);
        const disabled = Boolean(row.existingClusterId) || !href || (!checked && drafts.length >= BULK_LIMIT);
        return <li key={row.id} className={checked ? b.selectedRow : ""}><input type="checkbox" aria-label={t("Select existing page: {v0}", "选择已有页面：{v0}", { v0: row.title || row.url })} checked={checked} disabled={disabled} onChange={event => event.target.checked ? addPages([row]) : setDrafts(previous => previous.filter(draft => draft.pageId !== row.id))} /><div><strong>{row.title || t("No page title provided; enter one in the preview", "未提供页面标题，请在预览中填写")}</strong>{href ? <a href={href} target="_blank" rel="noreferrer">{row.url}<ExternalLink size={11} /></a> : <span className={b.url}>{row.url}</span>}<span className={b.rowHint}>{row.existingClusterId ? t("Already assigned to {v0}; duplicate import is unavailable", "已归入：{v0}，不可重复导入", { v0: row.existingPillarTitle || t("an existing pillar", "已有主题") }) : !href ? t("This URL belongs to another site and cannot be imported", "URL 不属于当前站点，不能导入") : row.articleCandidate ? t("Article candidate · Review required", "文章候选 · 需人工确认") : t("Other page · Check whether it belongs in article planning", "普通页面 · 请确认是否适合归为文章")}</span></div>{row.existingClusterId && <span className={s.subtleBadge}>{t("Already assigned", "已有归类")}</span>}</li>;
      })}</ul>}
      {inventory?.crawl && <div className={b.pagination}><span>{t("Total ", "共")} {inventory.total} {t(" matches · Page ", "条匹配 · 第")} {inventory.page} / {Math.max(1, Math.ceil(inventory.total / inventory.pageSize))} {t(" pages", "页")}</span><div><button className={s.secondary} disabled={loading || request.page <= 1} onClick={() => setRequest(previous => ({ ...previous, page: previous.page - 1 }))}>{t("Previous", "上一页")}</button><button className={s.secondary} disabled={loading || request.page * inventory.pageSize >= inventory.total} onClick={() => setRequest(previous => ({ ...previous, page: previous.page + 1 }))}>{t("Next", "下一页")}</button></div></div>}
      <div className={s.formActions}><button className={s.secondary} onClick={onClose}>{t("Cancel", "取消")}</button><button className={s.primary} disabled={!drafts.length || !pillars.length || loading} onClick={() => { setStep("preview"); setNotice(null); }} >{t("Next: confirm categories", "下一步：确认归类")}<ArrowRight size={15} /></button></div>
    </>}
    {step === "preview" && <ImportPreview drafts={drafts} pillars={pillars} pillarId={pillarId} onPillar={setPillarId} batchFunnel={batchFunnel} onBatchFunnel={value => { setBatchFunnel(value); setDrafts(previous => previous.map(draft => ({ ...draft, funnel: value }))); }} onEdit={updateDraft} onRemove={id => setDrafts(previous => previous.filter(draft => draft.pageId !== id))} onBack={() => setStep("select")} onSubmit={submit} busy={busy} domain={domain} />}
    {step === "result" && result && <>
      <div role="status" className={`${s.notice} ${s.noticeSuccess}`}><CheckCircle2 size={19} /><div><strong>{t("Imported ", "已导入")} {result.imported} {t(" items; skipped ", "条，跳过")} {result.skipped} {t(" items.", "条。")}</strong><p>{t("Imported items are marked Published. No briefs were generated or remote pages changed.", "导入条目记录为“已发布”，未生成简报，远程页面没有改变。")}</p></div></div>
      <ul className={b.resultList}>{result.results.map((item, index) => { const draft = drafts.find(row => row.pageId === item.pageId); return <li key={`${item.pageId}-${index}`}><span className={item.status === "imported" ? b.resultSuccess : b.resultSkipped}>{item.status === "imported" ? t("Imported ", "已导入") : t("Skipped", "已跳过")}</span><div><strong>{draft?.title || item.pageId}</strong><small>{item.status === "imported" ? t("Assigned to “{v0}”", "已归入“{v0}”", { v0: pillars.find(pillar => pillar.id === pillarId)?.title || t("the target pillar", "目标主题") }) : importSkipReason(item.reason, t)}</small>{draft && <span className={b.url}>{draft.url}</span>}</div></li>; })}</ul>
      <div className={s.formActions}>{result.results.some(item => item.status === "skipped" && item.reason === "keyword_conflict") && <button className={s.secondary} onClick={() => { const skippedIds = new Set(result.results.filter(item => item.status === "skipped" && item.reason === "keyword_conflict").map(item => item.pageId)); setDrafts(previous => previous.filter(draft => skippedIds.has(draft.pageId))); setResult(null); setStep("preview"); }}>{t("Edit conflicting keywords and retry", "修改关键词冲突项后重试")}</button>}<button className={s.primary} onClick={() => onComplete(pillarId, result)}>{t("Done: open article planning", "完成，查看文章规划")}<ArrowRight size={15} /></button></div>
    </>}
  </Modal>;
}

export function ImportPreview({ drafts, pillars, pillarId, onPillar, batchFunnel, onBatchFunnel, onEdit, onRemove, onBack, onSubmit, busy, domain }: {
  drafts: ImportDraft[]; pillars: Pillar[]; pillarId: string; onPillar: (id: string) => void; batchFunnel: Funnel; onBatchFunnel: (value: Funnel) => void;
  onEdit: (id: string, data: Partial<ImportDraft>) => void; onRemove: (id: string) => void; onBack: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; domain: string;
}) {
  const { t } = useI18n();
  const { FUNNELS } = getPlannerLabels(t);
  return <form onSubmit={onSubmit} className={s.form}>
    <div className={s.notice}><Info size={17} /><div>{t("Manually organize existing articles. Review each title and keyword; titles may contain site suffixes. Imported items are marked Published. No AI categorization, brief generation, or remote editing occurs.", "这是人工整理已有文章，不使用 AI 自动归类。标题可能带网站后缀，请逐条确认标题与关键词。导入后默认“已发布”，不生成简报、不修改远程正文。")}</div></div>
    <div className={s.formGrid}><label>{t("Assign to pillar", "归入总览主题")} <span>*</span><select aria-label={t("Target pillar for import", "导入目标主题")} value={pillarId} onChange={event => onPillar(event.target.value)} required disabled={busy}><option value="">{t("Select a target pillar", "请选择目标主题")}</option>{pillars.map(pillar => <option key={pillar.id} value={pillar.id}>{pillar.title}</option>)}</select></label><label>{t("Batch funnel stage", "批次读者阶段")}<select aria-label={t("Batch funnel stage", "批次读者阶段")} value={batchFunnel} onChange={event => onBatchFunnel(event.target.value as Funnel)} disabled={busy}>{(Object.keys(FUNNELS) as Funnel[]).map(funnel => <option key={funnel} value={funnel}>{funnel} · {FUNNELS[funnel].label}</option>)}</select><small>{t("Changes apply to every selected row; you can then adjust individual rows.", "修改将应用到全部已选行，之后仍可逐条调整。")}</small></label></div>
    <div className={b.previewList}>{drafts.map((draft, index) => <fieldset key={draft.pageId} className={b.previewRow}><legend>{t("Article ", "文章")} {index + 1}</legend><button type="button" className={`${s.iconButton} ${b.removeDraft}`} aria-label={t("Remove import item: {v0}", "移除导入项：{v0}", { v0: draft.title || draft.url })} onClick={() => onRemove(draft.pageId)} disabled={busy}><X size={15} /></button><div className={b.previewUrl}>{safeSiteUrl(draft.url, domain) ? <a href={safeSiteUrl(draft.url, domain)!} target="_blank" rel="noreferrer">{draft.url}<ExternalLink size={12} /></a> : <span>{draft.url}</span>}</div><label>{t("Article title", "文章标题")} <span>*</span><input aria-label={t("Article {v0} title", "文章 {v0} 标题", { v0: index + 1 })} value={draft.title} onChange={event => onEdit(draft.pageId, { title: event.target.value })} required maxLength={250} disabled={busy} /></label><div className={s.formGrid}><label>{t("Target keyword", "目标关键词")} <span>*</span><input aria-label={t("Article {v0} keyword", "文章 {v0} 关键词", { v0: index + 1 })} value={draft.keyword} onChange={event => onEdit(draft.pageId, { keyword: event.target.value })} required maxLength={250} disabled={busy} /></label><label>{t("Funnel stage", "读者阶段")}<select aria-label={t("Article {v0} funnel stage", "文章 {v0} 读者阶段", { v0: index + 1 })} value={draft.funnel} onChange={event => onEdit(draft.pageId, { funnel: event.target.value as Funnel })} disabled={busy}>{(Object.keys(FUNNELS) as Funnel[]).map(funnel => <option key={funnel} value={funnel}>{funnel} · {FUNNELS[funnel].label}</option>)}</select></label></div></fieldset>)}</div>
    {!drafts.length && <p className={b.warning}>{t("All items were removed. Return to the inventory to select pages.", "已移除全部条目，请返回库存重新选择。")}</p>}
    <div className={s.formActions}><button type="button" className={s.secondary} onClick={onBack} disabled={busy}><ArrowLeft size={15} />{t("Back to page selection", "返回选页")}</button><button className={s.primary} disabled={busy || !drafts.length || !pillarId}>{busy ? t("Importing…", "正在导入…") : t("Import {v0} existing articles", "确认导入 {v0} 条已有文章", { v0: drafts.length })}</button></div>
  </form>;
}
