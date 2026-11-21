"use client";

import { Copy, Download, FilePenLine, FileText, Loader2, Save, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { WORKBENCH_RESULTS } from "@/lib/ai-workbench/job-link";
import { CHATGPT_USAGE_URL } from "./chatgpt-connection";
import { TaskEvidence } from "./evidence-panel";
import { isAccountLimitError, isActiveJob, type DraftEditor, type ParagraphEdit, type WorkbenchJob } from "./model";
import { ParagraphReview } from "./paragraph-review";
import { ReportActions } from "./report-task";
import { LocalizationDetails, SchemaReviewList } from "./tool-results";
import { LinkReviewList, type TrustedSourcesApi } from "./trusted-sources";
import { workbenchErrorText, workbenchKindName, workbenchStatusName } from "./workbench-text";
import s from "./workbench.module.css";

/** The "Review and use" side of the Codex workbench: task history, the chosen task's result and its draft editor. */
export function WorkbenchResults({
  siteId,
  jobs,
  loading,
  selectedId,
  selectedJob,
  switchTo,
  editor,
  dirty,
  busy,
  trusted,
  onChooseJob,
  onKeepEditing,
  onDiscardEdits,
  onCancel,
  onEditorText,
  onSaveDraft,
  onCopyDraft,
  onDownloadDraft,
  onApplyEdit,
  onCopyResult,
}: {
  siteId: string;
  jobs: WorkbenchJob[];
  loading: boolean;
  selectedId: string | null;
  selectedJob: WorkbenchJob | undefined;
  switchTo: string | null;
  editor: DraftEditor | null;
  dirty: boolean;
  busy: string | null;
  trusted: TrustedSourcesApi;
  onChooseJob: (id: string) => void;
  onKeepEditing: () => void;
  onDiscardEdits: () => void;
  onCancel: (job: WorkbenchJob) => void;
  onEditorText: (text: string) => void;
  onSaveDraft: () => void;
  onCopyDraft: () => void;
  onDownloadDraft: () => void;
  onApplyEdit: (edit: ParagraphEdit) => void;
  onCopyResult: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const dateText = (date: string) =>
    new Date(date).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <section className={s.results} id={WORKBENCH_RESULTS}>
      <div className={s.sectionTitle}>
        <span className={s.step}>02</span>
        <div>
          <h2>{t("Review and use", "审阅与使用")}</h2>
          <p>{t("Your work is saved by site, as a draft.", "按站点保存任务，生成内容均为草稿。")}</p>
        </div>
      </div>
      <div className={s.history}>
        <label htmlFor="workbench-history">{t("Task history · latest 20", "任务记录 · 最近 20 条")}</label>
        <select id="workbench-history" value={selectedId ?? ""} onChange={event => onChooseJob(event.target.value)}>
          <option value="" disabled>
            {loading ? t("Loading…", "正在读取…") : t("Choose a task", "选择任务")}
          </option>
          {jobs.map(job => (
            <option key={job.id} value={job.id}>
              {workbenchStatusName(job, t)} · {job.title}
            </option>
          ))}
        </select>
      </div>
      {switchTo && (
        <div className={s.help} role="alert">
          <div>
            <p>
              {t("This draft has unsaved changes. Save or copy them before switching tasks.", "当前草稿有未保存的修改，请先保存或复制。")}
            </p>
            <div className={s.actions}>
              <button type="button" onClick={onKeepEditing}>
                {t("Keep editing", "继续编辑")}
              </button>
              <button type="button" onClick={onDiscardEdits}>
                {t("Discard edits and switch", "放弃编辑并切换")}
              </button>
            </div>
          </div>
        </div>
      )}
      {!selectedJob ? (
        <div className={s.empty}>
          <span>
            <FilePenLine size={38} />
          </span>
          <h3>{t("Your next draft starts here", "下一份草稿，从这里开始")}</h3>
          <p>
            {t(
              "Choose a task on the left. Codex will return an article or a practical fix plan for you to review.",
              "选择左侧任务，Codex 会返回文章草稿或具体修复方案，供你检查和使用。",
            )}
          </p>
          <div className={s.emptyTags}>
            <span>{t("Editable", "可编辑")}</span>
            <span>Markdown</span>
            <span>{t("Local history", "本地留存")}</span>
          </div>
        </div>
      ) : (
        <>
          <div className={s.jobHeading}>
            <div>
              <span className={`${s.status} ${selectedJob.status === "SUCCEEDED" ? s.ready : ""}`}>
                {workbenchStatusName(selectedJob, t)}
              </span>
              <span className={s.kind}>{workbenchKindName(selectedJob.kind, t)}</span>
              <h3>{selectedJob.title}</h3>
              <p>
                {dateText(selectedJob.createdAt)} · {t("Not published", "尚未发布")}
              </p>
            </div>
            {isActiveJob(selectedJob) && (
              <button type="button" className={s.cancel} onClick={() => onCancel(selectedJob)} disabled={!!busy}>
                <Square size={13} />
                {t("Cancel task", "取消任务")}
              </button>
            )}
          </div>
          {isActiveJob(selectedJob) && (
            <div className={s.progress} role="status">
              <Loader2 size={26} className={s.spinning} />
              <h3>
                {selectedJob.status === "QUEUED"
                  ? t("Waiting for the local helper", "等待本机助手处理")
                  : t("Codex is preparing your draft", "Codex 正在整理草稿")}
              </h3>
              <p>
                {t(
                  "This page checks progress every five seconds. You can leave and return to this task later.",
                  "页面每 5 秒检查进度。你可以稍后回来，在任务记录中查看结果。",
                )}
              </p>
            </div>
          )}
          {selectedJob.error && (
            <p className={s.jobError}>
              {workbenchErrorText(selectedJob.error, t)}{" "}
              {isAccountLimitError(selectedJob.error) && (
                <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                  {t("Manage usage", "管理用量")}
                </a>
              )}
            </p>
          )}
          {selectedJob.diagnosis && <TaskEvidence evidence={selectedJob.diagnosis} />}
          {selectedJob.result && editor?.jobId === selectedJob.id && (
            <>
              <p className={s.summary}>{selectedJob.result.summary}</p>
              {!!selectedJob.result.linkReview?.some(entry => entry.action === "REPLACED" || entry.action === "DROPPED") && (
                <p className={s.validation}>
                  {t(
                    "Links outside this site's verified pages and trusted sources were replaced by markers or removed. Open “SEO fields and review notes” to verify them.",
                    "库外链接已替换为“〔待核实〕”标记或已移除。展开“SEO 字段与审阅提示”逐个核对。",
                  )}
                </p>
              )}
              {!!selectedJob.result.reportActions?.length && (
                <ReportActions siteId={siteId} actions={selectedJob.result.reportActions} sources={selectedJob.reportSources ?? []} />
              )}
              {selectedJob.kind === "REWRITE_ARTICLE" && (
                <ParagraphReview
                  edits={selectedJob.result.paragraphEdits ?? []}
                  text={editor.text}
                  disabled={!!busy}
                  onApply={onApplyEdit}
                />
              )}
              {selectedJob.kind === "LOCALIZE_ARTICLE" && (
                <LocalizationDetails siteId={siteId} result={selectedJob.result} onCopy={onCopyResult} />
              )}
              {selectedJob.kind === "SCHEMA_MARKUP" && (
                <SchemaReviewList reviews={selectedJob.result.schemaReview ?? []} onCopy={onCopyResult} />
              )}
              <div className={s.editorBar}>
                <span>
                  <FileText size={16} />
                  {t("Draft text", "草稿正文")}
                  <small>{dirty ? t("Unsaved changes", "有未保存的修改") : t("Saved locally", "已存本机")}</small>
                </span>
                <div className={s.actions}>
                  <button type="button" onClick={onCopyDraft}>
                    <Copy size={15} />
                    {t("Copy", "复制")}
                  </button>
                  <button type="button" onClick={onDownloadDraft}>
                    <Download size={15} />
                    {t("Download .md", "下载 .md")}
                  </button>
                </div>
              </div>
              <textarea
                className={s.editor}
                aria-label={t("Draft text", "草稿正文")}
                spellCheck={false}
                maxLength={60000}
                value={editor.text}
                onChange={event => onEditorText(event.target.value)}
              />
              <div className={s.editorFooter}>
                <span>
                  {editor.text.length.toLocaleString()} / 60,000 {t("characters", "字符")}
                </span>
                <button type="button" disabled={!dirty || !!busy || !editor.text.trim()} onClick={onSaveDraft}>
                  <Save size={16} />
                  {busy === "save" ? t("Saving…", "保存中…") : t("Save draft", "保存草稿")}
                </button>
              </div>
              <details className={s.resultDetails}>
                <summary>{t("SEO fields and review notes", "SEO 字段与审阅提示")}</summary>
                <dl>
                  <dt>SEO Title</dt>
                  <dd>{selectedJob.result.metaTitle || t("Not provided", "未提供")}</dd>
                  <dt>Meta Description</dt>
                  <dd>{selectedJob.result.metaDescription || t("Not provided", "未提供")}</dd>
                </dl>
                {selectedJob.result.changeNotes.length > 0 && (
                  <>
                    <h4>{t("Changes to review", "建议检查的修改")}</h4>
                    <ul>
                      {selectedJob.result.changeNotes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  </>
                )}
                {selectedJob.result.factChecks.length > 0 && (
                  <>
                    <h4>{t("Facts to verify", "待核实信息")}</h4>
                    <ul>
                      {selectedJob.result.factChecks.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  </>
                )}
                <LinkReviewList entries={selectedJob.result.linkReview ?? []} api={trusted} disabled={!!busy} />
                {selectedJob.result.internalLinks.length > 0 && (
                  <>
                    <h4>{t("Suggested internal links", "内链建议")}</h4>
                    <ul>
                      {selectedJob.result.internalLinks.map((link, i) => (
                        <li key={i}>
                          <strong>{link.anchor}</strong>
                          <span className={s.sourceUrl}>{link.target}</span>
                          <p>{link.reason}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className={s.sourceHint}>
                  {t(
                    "These are the original generation notes. Editing draft text does not regenerate these fields or change the original result.",
                    "这里保留原始生成建议。编辑正文不会自动重写这些字段，也不会覆盖原始生成结果。",
                  )}
                </p>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
