"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, FileText, Loader2, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { DiagnosticEvidence } from "@/lib/ai-workbench/diagnostic-types";
import { RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import type { AccountExecution } from "./chatgpt-connection";
import type { TaskKind, WorkbenchData } from "./model";
import { OutputLanguageOptions, useOutputLanguage } from "./output-language";
import { TrustedSourcesPanel, type TrustedSourcesApi } from "./trusted-sources";
import type { ActiveTask } from "./use-site-tasks";
import { workbenchTasks } from "./workbench-text";
import s from "./workbench.module.css";

/** What the owner is writing into the workbench's task form. */
export function useWorkbenchForm(siteId: string) {
  const [kind, setKind] = useState<TaskKind>("WRITE_ARTICLE");
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [instructions, setInstructions] = useState("");
  // Drafts start in the site's market language (research settings) until another is picked.
  const { language, choose: setLanguage } = useOutputLanguage(siteId);
  const [clusterId, setClusterId] = useState("");
  const [pageId, setPageId] = useState("");
  const [body, setBody] = useState("");
  // Localization: the country to write for and, once published, the localized page's address.
  const [targetLocation, setTargetLocation] = useState(2840);
  const [targetUrl, setTargetUrl] = useState("");
  return {
    kind,
    setKind,
    title,
    setTitle,
    keyword,
    setKeyword,
    instructions,
    setInstructions,
    language,
    setLanguage,
    clusterId,
    setClusterId,
    pageId,
    setPageId,
    body,
    setBody,
    targetLocation,
    setTargetLocation,
    targetUrl,
    setTargetUrl,
  };
}
export type WorkbenchForm = ReturnType<typeof useWorkbenchForm>;

/** The "Create a task" form of the Codex workbench. */
export function WorkbenchComposer({
  siteId,
  form,
  clusters,
  pages,
  diagnosis,
  trusted,
  provider,
  busy,
  blockingJob,
  enoughBody,
  pageReady,
  canGenerate,
  onSubmit,
  onClearDiagnosis,
  onChooseCluster,
  onChoosePage,
}: {
  siteId: string;
  form: WorkbenchForm;
  clusters: WorkbenchData["clusters"];
  pages: WorkbenchData["pages"];
  diagnosis: DiagnosticEvidence | null;
  trusted: TrustedSourcesApi;
  provider: AccountExecution["provider"];
  busy: string | null;
  blockingJob: { kind: string } | ActiveTask | null;
  enoughBody: boolean;
  pageReady: boolean;
  canGenerate: boolean;
  onSubmit: (event: FormEvent) => void;
  onClearDiagnosis: () => void;
  onChooseCluster: (id: string) => void;
  onChoosePage: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <form className={s.composer} onSubmit={onSubmit}>
      <div className={s.sectionTitle}>
        <span className={s.step}>01</span>
        <div>
          <h2>{t("Create a task", "新建任务")}</h2>
          <p>{t("One click starts one new generation.", "每次点击生成，都会创建一个新任务。")}</p>
        </div>
      </div>
      {diagnosis && (
        <div className={s.taskEvidenceBinding}>
          <strong>{t("Saved evidence selected", "已选诊断依据")}</strong>
          <span>{diagnosis.page?.url ?? diagnosis.selection.url}</span>
          {diagnosis.selection.query && <span>{diagnosis.selection.query}</span>}
          <p>
            {t(
              "Evidence is checked again when you submit. A newer crawl requires a new preview.",
              "提交时会重新核对依据。有更新的抓取时，请刷新预览再带入。",
            )}
          </p>
          <button type="button" onClick={onClearDiagnosis}>
            {t("Clear selection", "取消带入")}
          </button>
        </div>
      )}
      <div className={s.taskChoices} role="group" aria-label={t("Task type", "任务类型")}>
        {workbenchTasks(t).map(task => (
          <button
            key={task.kind}
            className={`${s.taskChoice} ${form.kind === task.kind ? s.selectedTask : ""}`}
            type="button"
            aria-pressed={form.kind === task.kind}
            onClick={() => form.setKind(task.kind)}
          >
            <task.icon size={19} />
            <span>
              <strong>{task.title}</strong>
              <small>{task.description}</small>
            </span>
            {form.kind === task.kind && <Check size={16} />}
          </button>
        ))}
      </div>
      <label className={s.field}>
        <span>
          {t("Topic or goal", "题目或修复目标")} <b>*</b>
        </span>
        <input
          required
          maxLength={250}
          value={form.title}
          onChange={event => form.setTitle(event.target.value)}
          placeholder={
            form.kind === "SEO_FIX_PLAN"
              ? t("e.g. Fix duplicate titles on product pages", "例如：修复产品页的重复标题")
              : t("e.g. A complete guide for first-time readers", "例如：面向新用户的完整使用指南")
          }
        />
      </label>
      <div className={s.fieldRow}>
        <label className={s.field}>
          <span>{t("Target keyword", "目标关键词")}</span>
          <input
            maxLength={250}
            value={form.keyword}
            onChange={event => form.setKeyword(event.target.value)}
            placeholder={t("Optional", "可选")}
          />
        </label>
        <label className={s.field}>
          <span>{form.kind === "LOCALIZE_ARTICLE" ? t("Target language", "目标语言") : t("Output language", "生成内容语言")}</span>
          <select value={form.language} onChange={event => form.setLanguage(event.target.value)}>
            <OutputLanguageOptions />
          </select>
        </label>
      </div>
      {form.kind === "LOCALIZE_ARTICLE" && (
        <div className={s.fieldRow}>
          <label className={s.field}>
            <span>{t("Target country or region", "目标国家/地区")}</span>
            <select value={form.targetLocation} onChange={event => form.setTargetLocation(Number(event.target.value))}>
              {RESEARCH_LOCATIONS.map(item => (
                <option key={item.value} value={item.value}>
                  {locale === "zh" ? item.zh : item.en}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>{t("Localized page address (optional)", "本地化页面网址（选填）")}</span>
            <input
              type="url"
              maxLength={2048}
              value={form.targetUrl}
              onChange={event => form.setTargetUrl(event.target.value)}
              placeholder="https://"
            />
          </label>
        </div>
      )}
      <label className={s.field}>
        <span>{t("Requirements", "具体要求")}</span>
        <textarea
          rows={4}
          maxLength={6000}
          value={form.instructions}
          onChange={event => form.setInstructions(event.target.value)}
          placeholder={t(
            "Audience, tone, length, questions to answer, and facts to preserve…",
            "目标读者、语气、篇幅、需要回答的问题，以及必须保留的事实…",
          )}
        />
        <small>{t("Interface language does not change your output language.", "切换界面语言不会改变这里选择的内容语言。")}</small>
      </label>
      <details
        className={s.sources}
        open={form.kind === "REWRITE_ARTICLE" || form.kind === "LOCALIZE_ARTICLE" || form.kind === "SCHEMA_MARKUP"}
      >
        <summary>
          <FileText size={16} />
          {t("Article and site context", "文章与站点资料")}
        </summary>
        <label className={s.field}>
          <span>{t("Existing topic / brief", "已有选题或简报")}</span>
          <select value={form.clusterId} onChange={event => onChooseCluster(event.target.value)}>
            <option value="">{t("None selected", "暂不选择")}</option>
            {clusters.map(cluster => (
              <option key={cluster.id} value={cluster.id}>
                {cluster.pillarTitle} · {cluster.title}
              </option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          <span>{t("Crawled page", "已抓取页面")}</span>
          <select value={form.pageId} onChange={event => onChoosePage(event.target.value)}>
            <option value="">{t("None selected", "暂不选择")}</option>
            {pages.map(page => (
              <option key={page.id} value={page.id}>
                {page.title || page.url} ·{" "}
                {form.kind === "SCHEMA_MARKUP"
                  ? page.hasSchema
                    ? t("Has structured data", "已有结构化数据")
                    : t("No structured data", "缺结构化数据")
                  : page.hasBody
                    ? t("Body available", "有正文")
                    : t("Body needed", "需补充正文")}
              </option>
            ))}
          </select>
        </label>
        {form.pageId && <p className={s.sourceUrl}>{pages.find(page => page.id === form.pageId)?.url}</p>}
        <label className={s.field}>
          <span>{t("Original text or supporting material", "原文或补充资料")}</span>
          <textarea
            rows={7}
            maxLength={24000}
            value={form.body}
            onChange={event => form.setBody(event.target.value)}
            placeholder={t(
              "Paste article text. Pasted text takes precedence over the stored crawl text.",
              "粘贴文章正文。填写后优先使用这份文字，而非抓取的旧正文。",
            )}
          />
          <small>
            {form.body.length.toLocaleString()} / 24,000 {t("characters", "字符")}
          </small>
        </label>
        <p className={s.sourceHint}>
          {t(
            "This list is a sample: up to 150 pages from the latest completed crawl and 100 planned topics. If an article is missing, paste its text. Choosing a brief only adds its planning context; rewriting still needs page text.",
            "这里是样本：最多显示最近完成抓取的 150 个页面及 100 个选题。找不到文章时可粘贴原文。选题简报提供规划资料，改写仍需页面正文。",
          )}
        </p>
        <p className={s.sourceHint}>
          {t(
            "The task uses selected content and saved site evidence. It does not crawl a URL just because it appears in your request.",
            "任务使用选中的内容和本地已存站点证据。仅在要求里填写网址，不会自动抓取该网址。",
          )}
        </p>
      </details>
      <TrustedSourcesPanel api={trusted} disabled={!!busy} />
      {!enoughBody && (
        <p className={s.validation}>
          {form.kind === "LOCALIZE_ARTICLE"
            ? t(
                "For localization, select a page with saved body text or paste at least 100 characters.",
                "本地化需要选择已有正文的页面，或粘贴至少 100 个字符的原文。",
              )
            : t(
                "For rewriting, select a page with saved body text or paste at least 100 characters.",
                "改写需要选择已有正文的页面，或粘贴至少 100 个字符的原文。",
              )}
        </p>
      )}
      {!pageReady && (
        <p className={s.validation}>
          {t(
            "Structured data needs a crawled page: choose one under “Article and site context”.",
            "结构化数据需要一个已抓取的页面，请在“文章与站点资料”里选择。",
          )}
        </p>
      )}
      <p className={s.privacy}>
        {provider === "CHATGPT_APP"
          ? t(
              "Submitting sends your requirements and selected article/site evidence to OpenAI using this app's authorized ChatGPT connection.",
              "提交后，将通过此应用已授权的 ChatGPT 连接，向 OpenAI 发送任务要求及所选文章、站点证据。",
            )
          : t(
              "Submitting sends your requirements and selected article/site evidence through the local Codex account to generate a response.",
              "提交后，将通过本机 Codex 账号发送任务要求及所选文章、站点证据以生成结果。",
            )}
      </p>
      <button className={s.primaryButton} type="submit" disabled={!canGenerate}>
        {busy === "start" ? <Loader2 size={18} className={s.spinning} /> : <Sparkles size={18} />}
        {t("Generate with my account", "使用账号额度生成")}
        <ArrowRight size={17} />
      </button>
      {blockingJob && (
        <p className={s.sourceHint}>
          {t("This site has an active task. Wait for it to finish or cancel it first.", "当前站点已有任务正在处理，请等待完成或先取消。")}{" "}
          {blockingJob.kind === "KEYWORD_RESEARCH" && (
            <Link href={`/sites/${siteId}/keyword-research?mode=chatgpt`}>{t("View keyword task", "查看关键词任务")}</Link>
          )}{" "}
          {blockingJob.kind === "DOMAIN_ANALYSIS" && (
            <Link href={`/sites/${siteId}/domain-overview?mode=chatgpt`}>{t("View domain diagnosis", "查看域名诊断")}</Link>
          )}{" "}
          {blockingJob.kind === "BACKLINK_ANALYSIS" && (
            <Link href={`/sites/${siteId}/backlinks?mode=chatgpt`}>{t("View link analysis", "查看链接分析")}</Link>
          )}{" "}
          {blockingJob.kind === "META_REWRITE" && (
            <Link href={`/sites/${siteId}/opportunities`}>{t("View title rewrite", "查看标题改写")}</Link>
          )}{" "}
          {blockingJob.kind === "OUTREACH_EMAILS" && (
            <Link href={`/sites/${siteId}/backlinks`}>{t("View outreach drafts", "查看联络邮件")}</Link>
          )}{" "}
          {blockingJob.kind === "QUERY_CLUSTERS" && (
            <Link href={`/sites/${siteId}/content`}>{t("View query clusters", "查看搜索词聚类")}</Link>
          )}
        </p>
      )}
    </form>
  );
}
