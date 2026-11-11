"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { ImportablePagesResponse, ImportablePage } from "@/lib/content-planner/types";
import type { PlanJob, Pillar } from "./model";
import type { Mutation } from "./planner-forms";
import { FunnelBadge } from "./planner-ui";
import s from "./planner.module.css";
import b from "./bulk.module.css";

export function ArticleReviewPanel({ siteId, pillars, job, busy, active, workerOnline, onSubmit, onJob, onRefresh }: {
  siteId: string; pillars: Pillar[]; job?: PlanJob; busy: boolean; active: boolean; workerOnline: boolean;
  onSubmit: (action: Mutation) => Promise<Record<string, unknown> | null>; onJob: (id: string) => void; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [inventory, setInventory] = useState<ImportablePagesResponse | null>(null);
  const [page, setPage] = useState(1); const [query, setQuery] = useState(""); const [articlesOnly, setArticlesOnly] = useState(true);
  const [selected, setSelected] = useState<ImportablePage[]>([]); const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState<string[]>([]);
  useEffect(() => { setAccepted(job?.reviewResult?.articles.map(article => article.pageId) ?? []); }, [job?.id, job?.reviewResult]);
  useEffect(() => {
    if (job) return;
    const controller = new AbortController(); setLoading(true); setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: "25", query, articlesOnly: String(articlesOnly) });
    void fetch(`/api/sites/${encodeURIComponent(siteId)}/content/pages?${params}`, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(t("Could not load article inventory", "无法读取文章库存")); setInventory(await response.json()); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [siteId, page, query, articlesOnly, job, t]);
  if (job) return <div className={s.proposalReview}>
    {job.status === "FAILED" && <p role="alert">{t("Review failed. Existing articles were preserved.", "复核失败，已有文章保持原状。")} {job.error}</p>}
    {["QUEUED", "RUNNING"].includes(job.status) && <p role="status">{t("Reviewing selected article excerpts using your ChatGPT account. Results require your review before applying.", "正在通过 ChatGPT 账号复核所选文章摘要，完成后需你审阅并采纳。")}</p>}
    {job.reviewResult && <><p>{job.reviewResult.summary}</p><p className={s.notice}>{t("Accepting saves local classification and update briefs. Titles, URLs, publishing status and schedules of existing plans are preserved. Review confidence is a model estimate, not a measured SEO score.", "采纳后保存本地归类和更新简报，保留已有规划的标题、URL、发布状态和排期。置信度是模型判断，不是实测 SEO 分数。")}</p>
      {job.reviewResult.articles.map(article => {
        const source = job.reviewPages?.find(value => value.pageId === article.pageId);
        return <article className={s.proposal} key={article.pageId}>
          <div className={s.proposalHead}><input type="checkbox" aria-label={t("Accept article: {v0}", "采纳文章：{v0}", { v0: source?.title ?? article.pageId })} disabled={busy || !!job.appliedAt} checked={accepted.includes(article.pageId)} onChange={event => setAccepted(previous => event.target.checked ? [...previous, article.pageId] : previous.filter(id => id !== article.pageId))} /><h3>{source?.title}</h3><FunnelBadge funnel={article.funnel} /></div>
          <p>{source?.url} · {source?.source === "PASTED" ? t("User-pasted body", "用户粘贴正文") : t("Crawled body excerpt", "抓取正文摘要")}</p><p>{t("Pillar", "主题支柱")}: {pillars.find(pillar => pillar.id === article.pillarId)?.title ?? article.pillarId} · {article.keyword}</p>
          <p>{t("Confidence", "置信度")}: {article.confidence === "HIGH" ? t("High", "高") : article.confidence === "MEDIUM" ? t("Medium", "中") : t("Low", "低")} · {article.reason}</p>
          <ReviewTasks label={t("Keep", "保留")} tasks={article.keep} /><ReviewTasks label={t("Add", "补充")} tasks={article.add} /><ReviewTasks label={t("Rewrite", "修改")} tasks={article.rewrite} />
          {!!article.internalLinks.length && <div><h4>{t("Proposed internal links", "建议内链")}</h4>{article.internalLinks.map((link, index) => <p key={index}>{source?.url} → {link.sourceSection} → <strong>{link.anchor}</strong> → {link.target}<br />{link.reason}</p>)}</div>}
        </article>;
      })}
      <p>{job.appliedAt ? t("Accepted locally on {v0}. Website changes have not been verified; open the article brief to inspect link tasks after recrawling.", "已于 {v0} 本地采纳，尚未验证网站修改。重新抓取后打开文章简报查看内链任务。", { v0: job.appliedAt.slice(0, 10) }) : ""}</p><button className={s.primary} disabled={busy || !!job.appliedAt || !accepted.length} onClick={async () => { await onSubmit({ action: "applyArticleReview", jobId: job.id, pageIds: accepted }); }}>{job.appliedAt ? t("Accepted", "已采纳") : t("Accept selected reviews", "采纳所选归类与更新简报")}</button>
    </>}
    <button className={s.secondary} onClick={onRefresh}>{t("Refresh status", "刷新状态")}</button>
  </div>;
  const missing = selected.some(item => text[item.id]?.trim() ? text[item.id].trim().length < 100 : !item.hasArticleText);
  return <div className={s.planSetup}>
    <p className={s.notice}>{t("Select up to 5 existing articles. The AI reads up to 12,000 characters per article and available saved GSC evidence, then suggests a pillar, funnel stage and update tasks. This uses your ChatGPT account allowance after you click Start; results stay local until accepted.", "选择最多 5 篇旧文章。AI 阅读每篇最多 12000 字符正文及可用的本地 GSC 数据，建议主题支柱、读者阶段和具体修改任务。点击开始后使用 ChatGPT 账号额度，结果先保存为待审阅方案。")}</p>
    {!workerOnline && <p role="status">{t("The local account worker is offline. Start A-Border SEO before generating.", "账号生成服务离线，请先启动 A-Border SEO。")}</p>}
    <label>{t("Search articles", "搜索文章")}<input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
    <label className={s.checkboxLabel}><input type="checkbox" checked={articlesOnly} onChange={event => { setArticlesOnly(event.target.checked); setPage(1); }} />{t("Article candidates only", "仅显示文章候选")}</label>
    {error && <p role="alert">{error}</p>}
    <p>{t("Inventory uses the latest completed crawl. Pages outside that sample are not included.", "库存来自最近一次完成的抓取，不包含该次样本以外的页面。")}</p>
    <div className={b.inventoryList}>{inventory?.rows.map(item => <label key={item.id} className={s.checkboxLabel}><input type="checkbox" checked={selected.some(value => value.id === item.id)} disabled={loading || (!selected.some(value => value.id === item.id) && selected.length >= 5)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item] : previous.filter(value => value.id !== item.id))} /><span><strong>{item.title}</strong><br />{item.url}<br />{item.existingPillarTitle || t("Not yet classified", "尚未归类")} · {item.hasArticleText ? t("Crawled body available", "已有抓取正文") : t("Body required", "需要提供正文")}</span></label>)}</div>
    {!loading && inventory && !inventory.rows.length && <p>{t("No matching pages. Run a crawl or turn off the article-only filter.", "没有符合条件的页面，可先抓取或取消文章候选筛选。")}</p>}
    <div className={s.formActions}><button className={s.secondary} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>{t("Previous", "上一页")}</button><span>{page} / {Math.max(1, Math.ceil((inventory?.total ?? 0) / 25))}</span><button className={s.secondary} disabled={loading || page * 25 >= (inventory?.total ?? 0)} onClick={() => setPage(page + 1)}>{t("Next", "下一页")}</button></div>
    {selected.map(item => <details key={item.id} open={!item.hasArticleText}><summary>{item.title} · {t("Body evidence", "正文依据")}</summary><p>{t("Paste the article body to override the saved excerpt. Minimum 100 characters; do not paste credentials or private customer information. A future crawl automatically captures article text.", "可粘贴正文替代已有摘要，至少 100 字符。请勿粘贴密钥或客户私密信息。重新抓取也会自动保存正文摘要。")}</p><textarea aria-label={t("Article body: {v0}", "文章正文：{v0}", { v0: item.title })} rows={5} maxLength={12000} value={text[item.id] ?? ""} onChange={event => setText(previous => ({ ...previous, [item.id]: event.target.value }))} /></details>)}
    <div className={s.formActions}><span>{selected.length} / 5</span><button className={s.primary} disabled={busy || active || !pillars.length || !selected.length || missing} onClick={async () => { const result = await onSubmit({ action: "startArticleReview", pageIds: selected.map(item => item.id), pastedText: Object.fromEntries(selected.map(item => [item.id, text[item.id] ?? ""])) }); const next = result?.job as { id?: string } | undefined; if (next?.id) onJob(next.id); }}>{t("Start article review · Account mode", "开始旧文复核 · 账号模式")}</button></div>
  </div>;
}
function ReviewTasks({ label, tasks }: { label: string; tasks: string[] }) { return tasks.length ? <div><h4>{label}</h4><ul>{tasks.map((task, index) => <li key={index}>{task}</li>)}</ul></div> : null; }

export function OptimizationTasks({ optimization, outcome, busy, onRecord }: { optimization?: import("@/lib/content-planner/optimization-evidence").OptimizationEvidence | null; outcome?: import("@/lib/content-planner/update-outcome").UpdateOutcome | null; busy: boolean; onRecord: () => Promise<void> }) {
  const { t } = useI18n();
  if (!optimization) return null;
  return <section className={s.notice}><div><h3>{t("Accepted update tasks", "已采纳的更新任务")}</h3><p>{t("Accepted locally", "本地采纳")}: {optimization.acceptedAt.slice(0, 10)} · {optimization.bodySource === "PASTED" ? t("User-pasted body", "用户粘贴正文") : t("Crawled body", "抓取正文")}</p><p>{t("Apply text changes in your website CMS. Link checks below use a crawl completed after acceptance; they verify a URL link, not the proposed anchor or placement.", "请在网站后台实施正文修改。下方仅使用采纳之后完成的抓取检查 URL 链接，不代表已核实建议的锚文本或插入位置。")}</p>{optimization.links.map((link, index) => <div key={index}><p>{optimization.sourceUrl} → {link.sourceSection} → <strong>{link.anchor}</strong> → {link.target}</p><p>{link.reason}</p><strong>{link.status === "OBSERVED" ? t("Link observed", "已观察到链接") : link.status === "NOT_OBSERVED" ? t("Not observed in the latest crawl", "最近抓取未观察到") : t("Awaiting a new crawl", "等待重新抓取核验")}</strong></div>)}{optimization.crawlAt && <small>{t("Latest crawl", "最近抓取")}: {optimization.crawlAt.slice(0, 10)}</small>}{outcome ? <div><h4>{t("Website update recorded", "已记录网站更新")}: {outcome.websiteUpdatedAt.slice(0, 10)}</h4><p>{t("This date was confirmed by you. Traffic changes do not prove that this edit caused them.", "该日期由你确认，流量变化不代表一定由本次修改造成。")}</p>{outcome.baseline ? <p>{t("Before", "修改前")}: {outcome.baseline.start} ~ {outcome.baseline.end} · {outcome.baseline.clicks} {t("clicks", "点击")} / {outcome.baseline.impressions} {t("impressions", "曝光")}</p> : <p>{t("No complete baseline was available when recorded.", "记录时尚无完整的修改前基线。")}</p>}{outcome.after ? <p>{t("After", "修改后")}: {outcome.after.start} ~ {outcome.after.end} · {outcome.after.clicks} {t("clicks", "点击")} / {outcome.after.impressions} {t("impressions", "曝光")}</p> : <p>{t("Waiting for 28 complete days after the update and a GSC sync.", "等待更新之后 28 天完整数据及 GSC 同步。")}</p>}</div> : <button className={s.secondary} disabled={busy} onClick={() => { void onRecord(); }}>{t("I have updated this article on the website today", "我已在今天更新网站上的这篇文章")}</button>}</div></section>;
}
