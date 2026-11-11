"use client";
import type { Translator } from "@/lib/i18n/shared";

import { useI18n } from "@/lib/i18n/client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, CalendarDays, Check, CheckCircle2, ChevronRight, Copy, Download, FileDown, FileText, GitBranch, Globe, Info, Layers, LayoutGrid, List, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, TrendingUp, X } from "lucide-react";
import { ClusterForm, PillarForm, type Mutation } from "./planner-forms";
import { BriefContent, ConceptGuide, FunnelBadge, Modal } from "./planner-ui";
import { getPlannerLabels, applyPlanMessage, briefMarkdown, clusterRows, filterClusters, formatCount, jobLabel, linkEvidenceLabel, planErrorMessage, plannerStats, proposalSelectionCounts, runningJob, shortDate, type Cluster, type ClusterRow, type ContentStatus, type Funnel, type Pillar, type PlanJob, type PlannerData } from "./model";
import { ArticleReviewPanel, OptimizationTasks } from "./article-review";
import { BulkImport } from "./bulk-import";
import { ManagedArticleTable } from "./bulk-manage";
import { plannerApiError } from "./api-messages";
import { FunnelDistribution, FunnelSummary } from "./funnel-distribution";
import { presetFunnelCounts, validFunnelCounts, type FunnelCounts, type FunnelPreset } from "@/lib/content-planner/funnel";
import s from "./planner.module.css";
import b from "./bulk.module.css";

type Tab = "pillars" | "articles" | "board" | "map" | "guide";
type Panel = { kind: "review"; jobId?: string } | { kind: "import" } | { kind: "pillar"; item?: Pillar } | { kind: "cluster"; item?: Cluster; pillarId?: string; funnel?: Funnel } |
  { kind: "brief"; item: Cluster } | { kind: "plan"; pillarId: string; jobId?: string } |
  { kind: "delete"; entity: "pillar" | "cluster"; item: Pillar | Cluster } | null;
const EMPTY_PILLARS: Pillar[] = [];
function getTabs(t: Translator) { return [
  { id: "pillars" as const, title: t("Pillars", "主题支柱"), icon: Layers }, { id: "articles" as const, title: t("Articles", "文章规划"), icon: List },
  { id: "board" as const, title: t("Production board", "生产看板"), icon: LayoutGrid }, { id: "map" as const, title: t("Topic map", "主题图谱"), icon: GitBranch },
  { id: "guide" as const, title: t("Getting started", "新手指南"), icon: BookOpen },
]; }

function Notice({ children, tone = "info", action }: { children: ReactNode; tone?: "info" | "error" | "success"; action?: ReactNode }) {
  return <div className={`${s.notice} ${tone === "error" ? s.noticeError : tone === "success" ? s.noticeSuccess : ""}`} role={tone === "error" ? "alert" : "status"}><Info size={17} /><div>{children}</div>{action}</div>;
}

export function ContentPlanner({ siteId, domain, initialData }: { siteId: string; domain: string; initialData?: PlannerData }) {
  const { t } = useI18n();
  const { FUNNELS, STATUSES, SOURCE_LABELS } = getPlannerLabels(t);
  const [data, setData] = useState<PlannerData | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pillars");
  const [panel, setPanel] = useState<Panel>(null);
  const [filters, setFilters] = useState({ query: "", pillar: "", funnel: "", status: "" });
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/content`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("Content planning is temporarily unavailable. Please retry.", "暂时无法读取内容规划，请重试。"));
      if (body.site?.id !== siteId) throw new Error(t("The returned site does not match. Refresh and retry.", "返回的站点不匹配，请刷新页面后重试。"));
      setData(body as PlannerData);
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : t("Could not load data. Please retry.", "读取失败，请重试。"));
    } finally { if (!signal?.aborted) { setLoading(false); setRefreshing(false); } }
  }, [endpoint, siteId, t]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const activeJob = data?.jobs.find(runningJob);
  useEffect(() => {
    if (!activeJob || error) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void refresh(controller.signal); }, 3000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeJob, data, error, refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);

  async function mutate(mutation: Mutation): Promise<Record<string, unknown> | null> {
    setBusy(mutation.action); setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("The action did not complete. Check the content and retry.", "操作未完成，请检查内容后重试。"));
      await refresh();
      return body;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("The action did not complete. Please retry.", "操作未完成，请重试。")); return null; }
    finally { setBusy(null); }
  }
  function open(next: Panel) { setError(null); setPanel(next); }
  function close() { if (!busy) { setPanel(null); setError(null); } }
  async function save(mutation: Mutation) { if (await mutate(mutation)) { setPanel(null); setToast(t("Saved to this site's content planner.", "已保存到当前站点的内容规划。")); } }
  async function changeStatus(cluster: Cluster, status: ContentStatus) { if (await mutate({ action: "updateCluster", clusterId: cluster.id, data: { status } })) setToast(t("Updated to “{v0}”.", "已更新为“{v0}”。", { v0: STATUSES[status] })); }
  const pillars = data?.pillars ?? EMPTY_PILLARS;
  const rows = useMemo(() => clusterRows(pillars), [pillars]);
  const filtered = useMemo(() => filterClusters(rows, filters), [rows, filters]);
  const stats = useMemo(() => plannerStats(pillars), [pillars]);
  const supportsExample = /^(https?:\/\/)?ssad\.shop\/?$/.test(domain);
  const hasExamples = pillars.some(pillar => pillar.source === "EXAMPLE" || pillar.clusters.some(cluster => cluster.source === "EXAMPLE"));
  const planPillar = panel?.kind === "plan" ? pillars.find(pillar => pillar.id === panel.pillarId) : undefined;
  const planJob = panel?.kind === "plan" && panel.jobId ? data?.jobs.find(job => job.id === panel.jobId) : undefined;
  function showArticles(pillar: Pillar) { setFilters({ query: "", pillar: pillar.id, funnel: "", status: "" }); setTab("articles"); }
  function openPlan(pillar: Pillar) { const current = data?.jobs.find(job => job.kind !== "ARTICLE_REVIEW" && job.pillarId === pillar.id && (runningJob(job) || (job.status === "SUCCEEDED" && !job.appliedAt))); open({ kind: "plan", pillarId: pillar.id, jobId: current?.id }); }
  async function exportBrief(item: Cluster, copy: boolean) {
    if (!item.brief) return;
    const markdown = briefMarkdown(item.title, item.keyword, item.brief, t);
    if (copy) {
      try { await navigator.clipboard.writeText(markdown); setToast(t("The content brief was copied as Markdown.", "内容简报已复制为 Markdown。")); }
      catch { setError(t("The browser blocked copying. Use Export Markdown to save the brief.", "浏览器未允许复制，请使用“导出 Markdown”保存简报。")); }
    } else {
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${item.title.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80) || "content-brief"}.md`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const errorNotice = error ? <Notice tone="error" action={<button className={s.textButton} onClick={() => { void refresh(); }} disabled={refreshing}>{t("Reload", "重新读取")}</button>}>{plannerApiError(error, t)}</Notice> : null;

  return <section className={s.root} aria-label={t("{v0} content planner", "{v0} 内容规划", { v0: domain })}>
    <header className={s.header}>
      <div className={s.brand}><div className={s.brandIcon}><Layers size={25} /></div><div><div className={s.eyebrow}>{t("CONTENT PLANNER", "内容规划")}</div><h1>{t("Content planner", "内容规划")}<span>{t("Topics · Briefs · Schedule", "选题 · 简报 · 排期")}</span></h1></div></div>
      <div className={s.headerTools}><span className={s.siteChip}><Globe size={14} />{domain}</span><button className={s.iconButton} title={t("Reload saved data", "重新读取已保存数据")} aria-label={t("Reload saved data", "重新读取已保存数据")} onClick={() => { void refresh(); }} disabled={refreshing}><RefreshCw size={17} className={refreshing ? s.spin : ""} /></button></div>
    </header>
    <div className={s.workspace}>
      <div className={s.intro}><div><span className={s.eyebrow}>{t("Give every article a clear purpose", "让每一篇内容，都有明确的位置")}</span><h2>{t("Build a content journey around your topics.", "围绕主题，建立内容路径。")}</h2><p>{t("Start with readers' questions. Connect pillars, focused topics, and actionable writing briefs.", "从读者的问题出发，连接总览主题、具体选题与可执行的写作简报。")}</p></div><button className={s.secondary} onClick={() => setTab("guide")}><BookOpen size={16} />{t("Pillars and clusters in a minute", "一分钟认识 Pillar / Cluster")}<ArrowRight size={15} /></button></div>
      {!panel && errorNotice}
      {toast && <div className={s.toast} role="status"><CheckCircle2 size={17} />{toast}<button aria-label={t("Dismiss notice", "关闭提示")} onClick={() => setToast(null)}><X size={15} /></button></div>}
      <div className={s.metrics} aria-label={t("Planning metrics for this site", "当前站点规划指标")}>
        <Metric label={t("Pillars", "总览主题 · Pillars")} value={String(stats.pillars)} hint={t("Organize content around core questions", "围绕核心问题组织内容")} icon={<Layers />} tone="violet" />
        <Metric label={t("Clusters", "具体选题 · Clusters")} value={String(stats.clusters)} hint={t("{v0} briefs ready", "{v0} 份简报已就绪", { v0: rows.filter(row => row.brief).length })} icon={<FileText />} tone="cyan" />
        <Metric label={t("Content progress", "内容完成度")} value={`${stats.coverage}%`} hint={t("{v0} / {v1} marked Published", "{v0} / {v1} 条标记为已发布", { v0: stats.published, v1: stats.clusters })} icon={<CheckCircle2 />} tone="mint" />
        <Metric label={t("Linked-page GSC clicks", "已关联页面 GSC 点击")} value={formatCount(stats.clicks, t)} hint={t("{v0} unique URLs with saved data", "{v0} 个去重 URL 有已存数据", { v0: stats.mapped })} icon={<TrendingUp />} tone="violet" />
        <Metric label={t("Linked-page GSC impressions", "已关联页面 GSC 曝光")} value={formatCount(stats.impressions, t)} hint={data?.metricsPeriod ? t("{v0} to {v1}", "{v0} 至 {v1}", { v0: shortDate(data.metricsPeriod.startDate, t), v1: shortDate(data.metricsPeriod.endDate, t) }) : t("No GSC reporting period available", "尚无可用的 GSC 数据期间")} icon={<Globe />} tone="cyan" />
      </div>
      <div className={s.metricNote}><Info size={13} />{t("Progress tracks content production, not index coverage. GSC uses locally synced records only. Missing metrics show No data; monthly search volumes are not estimated.", "完成度是内容进度，不是索引覆盖率。GSC 仅使用本地已同步记录；缺失显示“暂无数据”，不估算月搜索量。")}</div>
      {activeJob && <button className={s.jobBanner} onClick={() => open({ kind: "plan", pillarId: activeJob.pillarId, jobId: activeJob.id })}><Loader2 size={18} className={s.spin} /><span><strong>{jobLabel(activeJob, t)}</strong> · {pillars.find(pillar => pillar.id === activeJob.pillarId)?.title ?? t("Pillar planning", "主题规划")}<small>{data?.worker.online ? t("Uses your ChatGPT account allowance. Review the results before importing.", "使用 ChatGPT 账号额度，结果生成后先由你审阅。") : t("The local generation service is offline. Open 启动服务.cmd. Your task is waiting.", "本机生成服务离线，请双击“启动服务.cmd”。任务正在等待。")}</small></span><ChevronRight size={18} /></button>}
      <div className={s.navigation}><div className={s.tabs} role="tablist" aria-label={t("Content planner views", "内容规划视图")}>{getTabs(t).map(({ id, title, icon: Icon }) => <button key={id} role="tab" id={`content-tab-${id}`} aria-selected={tab === id} aria-controls={`content-panel-${id}`} className={tab === id ? s.activeTab : ""} onClick={() => setTab(id)}><Icon size={16} />{title}</button>)}</div><div className={`${s.actions} ${b.actions}`}><button className={s.secondary} disabled={!pillars.length || loading} onClick={() => open({ kind: "review" })}><Sparkles size={15} />{t("Optimize existing articles", "旧文归类与优化")}</button><button className={`${s.secondary} ${b.importButton}`} onClick={() => open({ kind: "import" })} disabled={loading}><FileDown size={15} />{t("Import existing articles", "导入已有文章")}</button><button className={s.secondary} onClick={() => open({ kind: "pillar" })} disabled={loading}><Plus size={15} />{t("New pillar", "新建主题")}</button><button className={s.primary} onClick={() => open({ kind: "cluster", pillarId: filters.pillar || undefined })} disabled={!pillars.length}><Plus size={15} />{t("Add topic", "添加选题")}</button></div></div>
      <div role="tabpanel" id={`content-panel-${tab}`} aria-labelledby={`content-tab-${tab}`} className={s.tabPanel}>
        {loading ? <div className={s.loading}><Loader2 size={28} className={s.spin} /><p>{t("Loading ", "正在读取")} {domain} {t(" content planning…", "的内容规划…")}</p></div> : tab === "guide" ? <ConceptGuide /> : !data ? <Empty icon={<Info />} title={t("Planning is temporarily unavailable", "暂时无法读取规划")} text={t("Reload this site's data. Your existing content is preserved.", "可重新读取当前站点数据；现有内容不会受到影响。")} action={<button className={s.primary} onClick={() => { void refresh(); }}>{t("Reload", "重新读取")}</button>} /> : !pillars.length ?
          <div className={s.emptyStart}><div className={s.emptyOrb}><Layers size={34} /></div><span className={s.eyebrow}>{t("Start with your first pillar", "从第一个主题开始")}</span><h2>{t("Give your next article a clear direction", "给下一篇内容，一个清晰的方向")}</h2><p>{t("Create a pillar, then plan content that answers your readers' questions.", "先建立一个总览主题，再为它安排能真正回答读者问题的内容。")}</p><div className={s.startSteps}><span><b>01</b>{t("Define a pillar", "确定总览主题")}</span><ChevronRight /><span><b>02</b>{t("Identify focused questions", "拆分具体问题")}</span><ChevronRight /><span><b>03</b>{t("Review writing briefs", "审阅写作简报")}</span></div><div className={s.emptyActions}><button className={s.primary} onClick={() => open({ kind: "pillar" })}><Plus size={17} />{t("Create your first pillar", "建立第一个主题")}</button>{supportsExample && <button className={s.secondary} disabled={Boolean(busy)} onClick={async () => { if (await mutate({ action: "seedExample" })) setToast(t("Added Apple ID planning marked Demo example. These examples are not AI generated.", "已添加标记为“演示示例”的 Apple ID 内容规划。示例不是 AI 生成。 ")); }}><BookOpen size={17} />{busy === "seedExample" ? t("Adding example…", "添加示例中…") : t("Learn with an Apple ID example", "用 Apple ID 示例学习")}</button>}</div><small>{supportsExample ? t("Examples are added to this site's local planning only. They do not represent actual AI output, traffic, or publishing status.", "示例只加入当前站点的本地规划，不表示真实 AI 结果、流量或发布状态。") : t("Topics and briefs are saved for this site only. They do not edit or publish website content.", "选题与简报只保存在当前站点，不会修改或发布网站内容。")}</small></div>
          : <>
            {hasExamples && <div className={s.exampleNote}><span className={s.exampleBadge}>{t("Demo example", "演示示例")}</span>{t("Topics with this label are learning examples, not AI output. Any metrics come from actual GSC records for linked URLs.", "带此标记的选题用于学习，不是 AI 生成。指标若有值，只来自已关联 URL 的真实 GSC 记录。")}</div>}
            {tab === "pillars" && <><div className={s.sectionHeading}><div><h2>{t("Pillars", "主题支柱")} <span>{pillars.length}</span></h2><p>{t("Each pillar connects a group of focused questions. Select a card to view its topics.", "每个总览主题，连接一组具体问题。点击卡片查看选题。")}</p></div><span className={s.muted}>{t("This site only ·", "仅当前站点 ·")} {domain}</span></div><div className={s.pillarGrid}>{pillars.map((pillar, index) => <PillarCard key={pillar.id} pillar={pillar} index={index} busy={Boolean(busy)} onView={() => showArticles(pillar)} onEdit={() => open({ kind: "pillar", item: pillar })} onDelete={() => open({ kind: "delete", entity: "pillar", item: pillar })} onPlan={() => openPlan(pillar)} />)}</div>
              {Boolean(data.jobs.length) && <div className={s.history}><div className={s.sectionHeading}><div><h3>{t("AI planning history", "AI 规划记录")}</h3><p>{t("Review generated results before adding them to article planning.", "生成结果先审阅，确认后才加入文章规划。")}</p></div></div>{data.jobs.slice(0, 6).map(job => <button key={job.id} className={s.historyRow} onClick={() => open(job.kind === "ARTICLE_REVIEW" ? { kind: "review", jobId: job.id } : { kind: "plan", pillarId: job.pillarId, jobId: job.id })}><Sparkles size={16} /><span>{job.kind === "ARTICLE_REVIEW" ? t("Article review", "旧文复核") : pillars.find(pillar => pillar.id === job.pillarId)?.title ?? t("Deleted pillar", "已删除的主题")}</span><small>{shortDate(job.createdAt, t)}</small><span className={s.statusPill}>{jobLabel(job, t)}</span><ChevronRight size={16} /></button>)}</div>}</>}
            {(tab === "articles" || tab === "board") && <><div className={s.filters}><label className={s.search}><Search size={17} /><input aria-label={t("Search topic title or keyword", "搜索选题标题或关键词")} placeholder={t("Search title or keyword…", "搜索标题或关键词…")} value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} /></label><select aria-label={t("Filter by pillar", "筛选所属主题")} value={filters.pillar} onChange={event => setFilters({ ...filters, pillar: event.target.value })}><option value="">{t("All pillars", "全部主题")}</option>{pillars.map(pillar => <option key={pillar.id} value={pillar.id}>{pillar.title}</option>)}</select><select aria-label={t("Filter by funnel stage", "筛选读者阶段")} value={filters.funnel} onChange={event => setFilters({ ...filters, funnel: event.target.value })}><option value="">{t("All funnel stages", "全部读者阶段")}</option>{(Object.keys(FUNNELS) as Funnel[]).map(key => <option key={key} value={key}>{key} · {FUNNELS[key].label}</option>)}</select><select aria-label={t("Filter by production status", "筛选生产状态")} value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">{t("All production statuses", "全部生产状态")}</option>{(Object.keys(STATUSES) as ContentStatus[]).map(key => <option value={key} key={key}>{STATUSES[key]}</option>)}</select><button className={s.textButton} onClick={() => setFilters({ query: "", pillar: "", funnel: "", status: "" })}>{t("Reset", "重置")}</button><span className={s.filterCount}>{filtered.length} {t(" topics", "个选题")}</span></div>
              {tab === "articles" ? <ManagedArticleTable rows={filtered} allRows={rows} pillars={pillars} domain={domain} busy={Boolean(busy)} error={error} onBrief={item => open({ kind: "brief", item })} onEdit={item => open({ kind: "cluster", item })} onDelete={item => open({ kind: "delete", entity: "cluster", item })} onStatus={changeStatus} onSubmit={mutate} onClearError={() => setError(null)} onUpdated={count => setToast(t("Updated {v0} local article plans. Remote pages are unchanged.", "已批量更新 {v0} 条本地文章规划，远程页面未改变。", { v0: count }))} /> : !filtered.length ? <Empty icon={<Search />} title={rows.length ? t("No topics match these filters", "没有符合筛选条件的选题") : t("Your pillar is ready. Add focused questions next", "主题已准备好，接下来拆分具体问题")} text={rows.length ? t("Change the keyword or filters to find other content.", "调整关键词或筛选条件，查看其他内容。") : t("Add topics manually, or choose AI planning on a pillar card.", "可以手动添加，也可以在主题卡片中选择 AI 规划。")} action={<button className={s.secondary} onClick={() => rows.length ? setFilters({ query: "", pillar: "", funnel: "", status: "" }) : open({ kind: "cluster", pillarId: filters.pillar || undefined })}>{rows.length ? t("Clear filters", "清除筛选") : t("Add a topic", "添加一个选题")}</button>} /> : <Board rows={filtered} busy={Boolean(busy)} onBrief={item => open({ kind: "brief", item })} onEdit={item => open({ kind: "cluster", item })} onStatus={changeStatus} />}
            </>}
            {tab === "map" && <><div className={s.sectionHeading}><div><h2>{t("Topic map", "主题图谱")}</h2><p>{t("Shows planned relationships, not verified internal links. Actual link observations are labeled separately and limited by the crawl sample.", "展示规划关系，不代表已验证的真实内链。实际链接观察单独标注，受爬取样本限制。")}</p></div><span className={s.labelChip}>{t("Pillar → Cluster", "总览主题 → 具体选题")}</span></div><div className={s.topicMap}>{pillars.map(pillar => <section className={s.tree} key={pillar.id}><button className={s.treeRoot} onClick={() => showArticles(pillar)}><Layers size={21} /><span><small>{t("PILLAR · Overview topic", "PILLAR · 总览主题")}</small><strong>{pillar.title}</strong><em>{pillar.keyword}</em></span><ChevronRight size={18} /></button><div className={s.treeBranches}>{(Object.keys(FUNNELS) as Funnel[]).map(funnel => <div key={funnel} className={s.treeBranch}><FunnelBadge funnel={funnel} /><div>{pillar.clusters.filter(cluster => cluster.funnel === funnel).map(cluster => <button key={cluster.id} className={s.treeLeaf} onClick={() => open({ kind: "brief", item: cluster })}><FileText size={15} /><span>{cluster.title}<small>{STATUSES[cluster.status]} · {linkEvidenceLabel(cluster.linkEvidence, t)}</small></span></button>)}{!pillar.clusters.some(cluster => cluster.funnel === funnel) && <button className={s.addLeaf} onClick={() => open({ kind: "cluster", pillarId: pillar.id, funnel })}><Plus size={14} />{t("Add a topic for this stage", "添加此阶段的选题")}</button>}</div></div>)}</div></section>)}</div></>}
          </>}
      </div>
      <footer className={s.footer}><span><Globe size={13} />{domain} {t("· Planning for this site", "· 站点独立规划")}</span><span>{t("Topics and briefs only · No automatic publishing", "仅选题与内容简报 · 不自动发布文章")}</span></footer>
    </div>

    {panel?.kind === "review" && <Modal wide title={t("Classify and update existing articles", "旧文归类与更新")} onClose={close}>{errorNotice}<ArticleReviewPanel siteId={siteId} pillars={pillars} job={data?.jobs.find(job => job.id === panel.jobId)} busy={!!busy} active={!!activeJob} workerOnline={data?.worker.online ?? false} onSubmit={mutate} onJob={jobId => open({ kind: "review", jobId })} onRefresh={() => { void refresh(); }} /></Modal>}
    {panel?.kind === "import" && <BulkImport siteId={siteId} domain={domain} pillars={pillars} initialPillarId={filters.pillar || undefined} busy={Boolean(busy)} error={error} onSubmit={mutate} onClose={close} onCreatePillar={() => open({ kind: "pillar" })} onComplete={(pillarId, result) => { setPanel(null); setError(null); setFilters({ query: "", pillar: pillarId, funnel: "", status: "" }); setTab("articles"); setToast(t("Imported {v0} existing articles and skipped {v1}. Details were shown in the item results.", "已导入 {v0} 条已有文章，跳过 {v1} 条；详见刚才的逐项结果。", { v0: result.imported, v1: result.skipped })); }} />}
    {panel?.kind === "pillar" && <Modal title={panel.item ? t("Edit pillar", "编辑总览主题") : t("New pillar", "新建总览主题")} eyebrow={t("PILLAR", "主题支柱")} description={t("Define a broad topic's scope, audience, and goal, then break it into focused topics.", "为一个大主题确定范围、读者和目标，再拆分具体选题。")} onClose={close}>{errorNotice}<PillarForm key={panel.item?.id ?? "new"} item={panel.item} domain={domain} busy={Boolean(busy)} onSave={save} onCancel={close} /></Modal>}
    {panel?.kind === "cluster" && <Modal wide title={panel.item ? t("Edit topic", "编辑具体选题") : t("Add topic", "添加具体选题")} eyebrow={t("CLUSTER", "具体选题")} description={t("Each article answers one clear question, with its own brief, schedule, and status.", "每篇内容只解决一个明确的问题，并记录简报、排期与状态。")} onClose={close}>{errorNotice}<ClusterForm key={panel.item?.id ?? panel.pillarId ?? "new"} item={panel.item} pillars={pillars} initialPillarId={panel.pillarId} initialFunnel={panel.funnel} domain={domain} busy={Boolean(busy)} onSave={save} onCancel={close} /></Modal>}
    {panel?.kind === "delete" && <Modal title={panel.entity === "pillar" ? t("Delete this pillar?", "删除这个总览主题？") : t("Delete this topic?", "删除这个选题？")} onClose={close}>{errorNotice}<div className={s.deleteContent}><Trash2 size={30} /><h3>{panel.item.title}</h3><p>{panel.entity === "pillar" ? t("This also deletes its {v0} topics, briefs, and related planning records.", "同时删除其下 {v0} 个选题、简报及相关规划记录。", { v0: (panel.item as Pillar).clusters.length }) : t("This topic's brief, schedule, and local status will also be deleted.", "该选题的简报、排期与本地状态会一并删除。")}{t("Only local planning is affected. Website pages are not deleted.", "本次操作只影响本地规划，不删除网站页面。")}</p></div><div className={s.formActions}><button className={s.secondary} disabled={Boolean(busy)} onClick={close}>{t("Keep content", "保留内容")}</button><button className={s.danger} disabled={Boolean(busy)} onClick={async () => { if (await mutate(panel.entity === "pillar" ? { action: "deletePillar", pillarId: panel.item.id } : { action: "deleteCluster", clusterId: panel.item.id })) { setPanel(null); setToast(t("Local planning item deleted.", "已删除本地规划条目。")); } }}>{busy ? t("Deleting…", "删除中…") : t("Confirm deletion", "确认删除")}</button></div></Modal>}
    {panel?.kind === "brief" && <Modal wide title={panel.item.title} eyebrow={t("CONTENT BRIEF", "CONTENT BRIEF · 内容简报")} description={t("{v0} · {v1} · Not a finished article", "{v0} · {v1} · 不是已完成的文章", { v0: panel.item.keyword, v1: SOURCE_LABELS[panel.item.source] })} onClose={close}>{errorNotice}<div className={s.briefToolbar}><FunnelBadge funnel={panel.item.funnel} /><div><button className={s.secondary} disabled={!panel.item.brief} onClick={() => { void exportBrief(panel.item, true); }}><Copy size={15} />{t("Copy", "复制")}</button><button className={s.secondary} disabled={!panel.item.brief} onClick={() => { void exportBrief(panel.item, false); }}><Download size={15} />{t("Export Markdown", "导出 Markdown")}</button><button className={s.primary} onClick={() => open({ kind: "cluster", item: panel.item })}><Pencil size={15} />{t("Edit", "编辑")}</button></div></div><OptimizationTasks optimization={panel.item.optimization} outcome={rows.find(row => row.id === panel.item.id)?.updateOutcome} busy={!!busy} onRecord={async () => { await mutate({ action: "recordWebsiteUpdate", clusterId: panel.item.id }); }} />{panel.item.brief ? <BriefContent brief={panel.item.brief} domain={domain} /> : <Empty icon={<FileText />} title={t("This topic has no brief yet", "这个选题还没有简报")} text={t("Add an outline, key points, and internal links manually, or return to the pillar and ask AI for topics with briefs.", "可以手动补充大纲、要点和站内链接；也可以回到所属主题，让 AI 提出一组带简报的选题。")} action={<button className={s.primary} onClick={() => open({ kind: "cluster", item: panel.item })}>{t("Add a brief", "补充简报")}</button>} />}</Modal>}
    {panel?.kind === "plan" && <Modal wide title={planPillar?.title ?? t("AI content planning", "AI 内容规划")} eyebrow={t("AI PLANNER · Review before import", "AI PLANNER · 先审阅，再导入")} description={t("Uses your ChatGPT account allowance to plan topics and briefs, not full articles.", "使用 ChatGPT 账号额度，只规划选题与内容简报，不生成整篇文章。")} onClose={close}>{errorNotice}<PlanPanel key={panel.jobId ?? panel.pillarId} pillar={planPillar} job={planJob} workerOnline={data?.worker.online ?? false} domain={domain} busy={Boolean(busy)} otherJob={Boolean(activeJob && activeJob.id !== panel.jobId)} onRefresh={() => { void refresh(); }} onStart={async (topicCount) => {
      const result = await mutate({ action: "startPlan", pillarId: panel.pillarId, topicCount: topicCount.total, funnelCounts: topicCount.funnelCounts });
      const job = result?.job as { id?: string } | undefined;
      if (job?.id) setPanel({ ...panel, jobId: job.id });
    }} onApply={async (topicIndexes, updateExistingBriefs) => {
      if (!planJob) return;
      const result = await mutate({ action: "applyPlan", jobId: planJob.id, topicIndexes, updateExistingBriefs });
      if (result) { setPanel(null); setFilters({ query: "", pillar: panel.pillarId, funnel: "", status: "" }); setTab("articles"); setToast(applyPlanMessage(result, new Set(topicIndexes).size, t)); }
    }} /></Modal>}
  </section>;
}

function Metric({ label, value, hint, icon, tone }: { label: string; value: string; hint: string; icon: ReactNode; tone: string }) {
  const { t } = useI18n();
  return <article className={`${s.metric} ${s[tone]}`}><div>{label}<span>{icon}</span></div><strong className={value === t("No data", "暂无数据") ? s.noMetric : ""}>{value}</strong><small>{hint}</small></article>;
}
function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className={s.empty}><div>{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function PillarCard({ pillar, index, busy, onView, onEdit, onDelete, onPlan }: { pillar: Pillar; index: number; busy: boolean; onView: () => void; onEdit: () => void; onDelete: () => void; onPlan: () => void }) {
  const { t } = useI18n();
  const { FUNNELS } = getPlannerLabels(t);
  const complete = pillar.clusters.filter(cluster => cluster.status === "PUBLISHED").length;
  const progress = pillar.clusters.length ? Math.round(complete / pillar.clusters.length * 100) : 0;
  return <article className={s.pillarCard}><div className={s.cardTop}><span>{t("PILLAR", "主题支柱")} {String(index + 1).padStart(2, "0")}</span><div>{pillar.source === "EXAMPLE" && <span className={s.exampleBadge}>{t("Demo example", "演示示例")}</span>}<button className={s.iconButton} title={t("Edit pillar", "编辑主题")} aria-label={t("Edit pillar: {v0}", "编辑主题：{v0}", { v0: pillar.title })} onClick={onEdit}><Pencil size={15} /></button><button className={s.iconButton} title={t("Delete pillar", "删除主题")} aria-label={t("Delete pillar: {v0}", "删除主题：{v0}", { v0: pillar.title })} onClick={onDelete}><Trash2 size={15} /></button></div></div><button className={s.cardTitle} onClick={onView}><h3>{pillar.title}</h3><ChevronRight size={18} /></button><div className={s.keyword}>{pillar.keyword}</div><p className={s.cardDescription}>{pillar.description || t("No description yet. Add the audience and scope for more focused planning.", "还没有主题说明，补充读者和内容范围可帮助规划更准确。")}</p><div className={s.funnelCounts}>{(Object.keys(FUNNELS) as Funnel[]).map(key => <span key={key} className={s[key]}>{key} <b>{pillar.clusters.filter(cluster => cluster.funnel === key).length}</b></span>)}</div><div className={s.cardProgress}><div><span>{t("Content progress", "内容完成度")} <small>{complete}/{pillar.clusters.length}</small></span><strong>{progress}%</strong></div><div className={s.progressTrack}><span style={{ width: `${progress}%` }} /></div></div><div className={s.cardBottom}><button className={s.textButton} onClick={onView}>{pillar.clusters.length} {t(" focused topics", "个具体选题")}<ArrowRight size={14} /></button><button className={s.aiButton} onClick={onPlan} disabled={busy}><Sparkles size={15} />{t("AI planning", "AI 规划")}</button></div></article>;
}
function Board({ rows, busy, onBrief, onEdit, onStatus }: { rows: ClusterRow[]; busy: boolean; onBrief: (row: Cluster) => void; onEdit: (row: Cluster) => void; onStatus: (row: Cluster, status: ContentStatus) => Promise<void> }) {
  const { t } = useI18n();
  const { STATUSES } = getPlannerLabels(t);
  return <div className={s.board}>{(Object.keys(STATUSES) as ContentStatus[]).map(status => <section className={s.boardColumn} key={status}><h3><span className={`${s.statusDot} ${status === "PUBLISHED" ? s.publishedDot : ""}`} />{STATUSES[status]}<span>{rows.filter(row => row.status === status).length}</span></h3><div className={s.boardItems}>{rows.filter(row => row.status === status).map(row => <article className={s.boardCard} key={row.id}><div><FunnelBadge funnel={row.funnel} /><button className={s.iconButton} aria-label={t("Edit topic: {v0}", "编辑选题：{v0}", { v0: row.title })} onClick={() => onEdit(row)}><Pencil size={14} /></button></div><button className={s.rowTitle} onClick={() => onBrief(row)}>{row.title}</button><small>{row.pillarTitle}</small><span className={s.keyword}>{row.keyword}</span><div className={s.boardDate}><CalendarDays size={13} />{shortDate(row.scheduledFor, t)}{row.brief && <span><Check size={12} />{t("Brief ready", "有简报")}</span>}</div><select aria-label={t("Move “{v0}” to a production stage", "移动“{v0}”到生产阶段", { v0: row.title })} value={row.status} disabled={busy} onChange={event => { void onStatus(row, event.target.value as ContentStatus); }}>{(Object.keys(STATUSES) as ContentStatus[]).map(key => <option key={key} value={key}>{STATUSES[key]}</option>)}</select></article>)}{!rows.some(row => row.status === status) && <p className={s.emptyColumn}>{t("No topics yet", "暂无选题")}<br /><small>{t("Use each card's status menu to move content", "用卡片的状态菜单移动内容")}</small></p>}</div></section>)}</div>;
}

export function PlanPanel({ pillar, job, workerOnline, domain, busy, otherJob, onStart, onApply, onRefresh }: { pillar?: Pillar; job?: PlanJob; workerOnline: boolean; domain: string; busy: boolean; otherJob: boolean; onStart: (settings: { total: number; funnelCounts: FunnelCounts }) => Promise<void>; onApply: (indexes: number[], updateExistingBriefs: boolean) => Promise<void>; onRefresh: () => void }) {
  const { t } = useI18n();
  const [count, setCount] = useState(job?.topicCount ?? 9);
  const [funnelCounts, setFunnelCounts] = useState<FunnelCounts>(job?.funnelCounts ?? presetFunnelCounts(job?.topicCount ?? 9));
  const [preset, setPreset] = useState<FunnelPreset | "custom">(job?.funnelCounts ? "custom" : "balanced");
  const [setupForJob, setSetupForJob] = useState<string | null>(null);
  const completedJob = job?.status === "SUCCEEDED" && job.result ? job : null;
  if (completedJob && setupForJob !== completedJob.id) return <ProposalReview job={completedJob} existingClusters={pillar?.clusters ?? []} domain={domain} busy={busy} onApply={onApply} planningBlocked={otherJob || !pillar} onConfigureNew={() => { if (!busy && !otherJob && pillar) setSetupForJob(completedJob.id); }} />;
  if (job && runningJob(job)) return <div className={s.planWaiting}><div className={s.planOrb}><Loader2 size={31} className={s.spin} /></div><span className={s.eyebrow}>{job.status === "QUEUED" ? "QUEUED" : "PLANNING"}</span><h3>{job.status === "QUEUED" ? t("Topic planning is queued", "选题规划已排队") : t("Preparing topics and writing briefs", "正在组织选题与写作简报")}</h3><p>{workerOnline ? t("Using your ChatGPT account allowance. You can close this dialog while the task continues. Review and select results before importing.", "正在使用 ChatGPT 账号额度。你可以关闭弹窗，任务会继续；完成后仍需你审阅并选择导入。") : t("The local generation service is offline. Open 启动服务.cmd. Queued tasks resume when the service is online.", "本机生成服务未在线。请双击“启动服务.cmd”，服务恢复后会处理排队任务。")}</p><div className={s.planSteps}><span><CheckCircle2 size={16} />{t("Submit pillar", "提交主题")}</span><span className={s.currentStep}><Loader2 size={16} className={s.spin} />{job.status === "QUEUED" ? t("Waiting for local service", "等待本机服务") : t("Generate proposals", "生成候选方案")}</span><span>{t("Review and import", "你审阅并导入")}</span></div><button className={s.secondary} onClick={onRefresh}><RefreshCw size={15} />{t("Check status", "检查状态")}</button><small>{t("No automatic switch to a paid API or automatic publishing.", "不会自动切换到付费 API，不会自动发布内容。")}</small></div>;
  return <div className={s.planSetup}>{job?.status === "FAILED" && <Notice tone="error">{planErrorMessage(job.error, t)}</Notice>}{job && !["FAILED", "SUCCEEDED"].includes(job.status) && <Notice tone="error">{t("Unrecognized task status “", "无法识别任务状态“")}{job.status}{t("”. Reload and confirm the previous task has ended before retrying.", "”。请重新读取；确认旧任务结束后再重试。")}<button className={s.textButton} onClick={onRefresh}>{t("Check status", "检查状态")}</button></Notice>}
    {completedJob && <Notice action={<button type="button" className={s.secondary} disabled={busy} onClick={() => setSetupForJob(null)}>{t("Back to saved proposal", "返回已保存方案")}</button>}>{t("Your previous proposal is preserved. Adjusting these settings does not create a task or use model allowance. Only Generate starts a new task.", "原方案仍保留。调整设置不会创建任务或使用模型额度，只有点击生成才会新建任务。")}</Notice>}
    <div className={s.planSummary}><div className={s.planOrb}><Sparkles size={30} /></div><div><h3>{t("Turn a broad topic into an actionable content plan", "把一个大主题，变成可执行的内容清单")}</h3><p>{t("Each suggestion includes a keyword, funnel stage, angle, outline, key points, and internal link suggestions.", "每个建议包含关键词、读者阶段、内容角度、大纲、要点和站内链接建议。")}</p></div></div>
    <div className={s.planContext}><div><span>{t("Core keyword", "核心关键词")}</span><strong>{pillar?.keyword ?? t("Pillar deleted", "主题已删除")}</strong></div><div><span>{t("Target audience", "目标读者")}</span><strong>{pillar?.audience || t("Not specified; inferred from the topic", "未填写，将依据主题判断")}</strong></div><div><span>{t("Content goal", "内容目标")}</span><strong>{pillar?.goal || t("Not specified; add a goal for more focused results", "未填写，建议补充以提高针对性")}</strong></div></div>
    <FunnelDistribution total={count} counts={funnelCounts} preset={preset} disabled={busy || otherJob} onTotal={total => { setCount(total); if (preset !== "custom") setFunnelCounts(presetFunnelCounts(total, preset)); }} onPreset={value => { setPreset(value); if (value !== "custom") setFunnelCounts(presetFunnelCounts(count, value)); }} onCount={(stage, value) => { setPreset("custom"); setFunnelCounts(previous => ({ ...previous, [stage]: value })); }} />
    <Notice>{t("Sends this pillar, relevant site pages, and some saved GSC data to ChatGPT using your account allowance. Generated proposals are saved for review, without automatic import or publishing.", "将当前主题、相关站内页面和已保存的部分 GSC 数据发送给 ChatGPT 模型，使用你的 ChatGPT 账号额度。生成结果只进入候选区，不会自动加入规划或发布。")}</Notice>
    {!workerOnline && <Notice>{t("The local generation service is offline. Open 启动服务.cmd. You can queue a task now; it runs when the service returns, without switching to API mode.", "本机生成服务离线。请双击“启动服务.cmd”。也可以先提交排队；服务恢复后处理，不会改用 API。")}</Notice>}
    {otherJob && <Notice>{t("This site already has a planning task. Wait for it to finish before starting another.", "当前站点已有一项规划任务，请等待它完成后再开始新任务。")}</Notice>}
    <div className={s.formActions}><span className={s.accountBadge}><CheckCircle2 size={15} />{t("ChatGPT account mode", "ChatGPT 账号模式")}</span><button className={s.primary} disabled={busy || otherJob || !pillar || !validFunnelCounts(funnelCounts, count) || Boolean(job && !["FAILED", "SUCCEEDED"].includes(job.status))} onClick={() => { if (validFunnelCounts(funnelCounts, count)) void onStart({ total: count, funnelCounts }); }}><Sparkles size={17} />{busy ? t("Submitting…", "正在提交…") : job?.status === "FAILED" ? t("Regenerate plan", "重新生成规划") : t("Generate topics and briefs", "生成选题与简报")}</button></div>
  </div>;
}
export function ProposalReview({ job, existingClusters, domain, busy, onApply, onConfigureNew, planningBlocked = false }: {
  job: PlanJob; existingClusters: Cluster[]; domain: string; busy: boolean;
  onApply: (indexes: number[], updateExistingBriefs: boolean) => Promise<void>;
  onConfigureNew?: () => void; planningBlocked?: boolean;
}) {
  const { t } = useI18n();
  const topics = job.result?.topics ?? [];
  const [selected, setSelected] = useState<number[]>(topics.map((_, index) => index));
  const [updateExistingBriefs, setUpdateExistingBriefs] = useState(false);
  const counts = proposalSelectionCounts(topics, existingClusters, selected, updateExistingBriefs);
  const noChanges = counts.added + counts.updated === 0;
  return <div className={s.proposalReview}>
    <Notice tone="success">{job.appliedAt ? t("These results were accepted. The original proposal is kept below; edit imported content in article planning.", "这份结果已采纳。下方保留生成时的方案，后续可在文章规划中编辑。") : t("Generated {v0} topic proposals. Check their suitability and select the items to accept.", "已生成 {v0} 个候选选题。请核实内容适用性，选择需要的条目后再采纳。", { v0: topics.length })}</Notice>
    {onConfigureNew && <div className={s.proposalToolbar}><button type="button" className={s.secondary} disabled={busy || planningBlocked} onClick={onConfigureNew}><Sparkles size={15} />{t("Adjust mix and create a new plan", "调整分配并新建规划")}</button><span className={s.muted}>{t("Opens settings only; keeps this proposal.", "仅打开设置，保留当前方案。")}</span></div>}
    <p className={s.planRationale}>{job.result?.pillarSummary}</p>
    {job.funnelCounts && <FunnelSummary counts={job.funnelCounts} label={t("Requested mix", "本任务要求的阶段数量")} />}
    <FunnelSummary counts={{ TOFU: topics.filter(topic => topic.funnel === "TOFU").length, MOFU: topics.filter(topic => topic.funnel === "MOFU").length, BOFU: topics.filter(topic => topic.funnel === "BOFU").length }} label={t("Generated mix before selection", "采纳筛选前的生成数量")} />
    <div className={s.proposalToolbar}>
      <label className={s.checkboxLabel}><input type="checkbox" checked={selected.length === topics.length} disabled={Boolean(job.appliedAt)} onChange={event => setSelected(event.target.checked ? topics.map((_, index) => index) : [])} />{t("Select all", "全选")}</label>
      <span>{t("Selected ", "已选")} {selected.length} / {topics.length}</span><span className={s.labelChip}>{t("AI generated · Human review required", "AI 生成 · 尚需人工核实")}</span>
    </div>
    {!job.appliedAt && counts.existingIndexes.length > 0 && <div className={s.notice}>
      <Info size={17} /><div>
        <label className={s.checkboxLabel}><input type="checkbox" checked={updateExistingBriefs} disabled={busy} onChange={event => setUpdateExistingBriefs(event.target.checked)} />{t("Also update existing briefs (keep titles, URLs, schedules, and progress)", "同时更新已有选题的简报（保留标题、URL、排期和进度）")}</label>
        <p>{t("Unchecked: skip existing topics with the same keyword. Checked: update only the brief and AI source label; keep other details.", "未勾选时跳过相同关键词的已有选题。勾选后只更新简报与 AI 来源标记，其余信息保留。")}</p>
      </div>
    </div>}
    {!job.appliedAt && <Notice>{t("Current selection: add {v0} topics, update {v1} briefs, skip {v2} duplicates.", "按当前选择：新增 {v0} 个选题，更新 {v1} 份简报，跳过重复 {v2} 个。", { v0: counts.added, v1: counts.updated, v2: counts.skipped })}{noChanges && selected.length > 0 && t("All selected topics already exist. Enable brief updates or change your selection before accepting.", "所选选题均已存在，请勾选更新简报后再采纳，或返回调整选择。")}</Notice>}
    <div className={s.proposals}>{topics.map((topic, index) => <article className={`${s.proposal} ${selected.includes(index) ? s.selectedProposal : ""}`} key={index}>
      <div className={s.proposalHead}>
        <input type="checkbox" aria-label={t("Accept topic: {v0}", "采纳选题：{v0}", { v0: topic.title })} checked={selected.includes(index)} disabled={Boolean(job.appliedAt)} onChange={event => setSelected(previous => event.target.checked ? [...previous, index] : previous.filter(value => value !== index))} />
        <div><h3>{topic.title}</h3><span className={s.keyword}>{topic.keyword}</span>{counts.existingIndexes.includes(index) && <span className={s.labelChip}>{t("Existing topic", "已有选题")}</span>}</div><FunnelBadge funnel={topic.funnel} />
      </div>
      <p>{topic.brief.summary}</p><details><summary>{t("Expand content brief", "展开内容简报")} <ChevronRight size={14} /></summary><BriefContent brief={topic.brief} domain={domain} /></details>
    </article>)}</div>
    <div className={s.applyBar}>
      <p>{job.appliedAt ? t("Accepted: {v0}", "采纳时间：{v0}", { v0: shortDate(job.appliedAt, t) }) : t("Only selected items are processed. Existing topics are skipped unless brief updates are enabled. Each result can be accepted once; unselected items remain in the proposal history.", "仅处理所选条目；已有选题默认跳过，只有明确勾选才更新简报。每份结果只能采纳一次，未选条目保留在候选记录中。")}</p>
      <button className={s.primary} disabled={busy || !selected.length || noChanges || Boolean(job.appliedAt)} onClick={() => { void onApply(selected, updateExistingBriefs); }}><Check size={17} />{job.appliedAt ? t("Accepted", "已采纳") : busy ? t("Accepting…", "正在采纳…") : t("Accept {v0} topics", "确认采纳 {v0} 个选题", { v0: selected.length })}</button>
    </div>
  </div>;
}
