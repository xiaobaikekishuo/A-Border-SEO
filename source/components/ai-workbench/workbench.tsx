"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Check, CircleHelp, Globe, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { ActionScope } from "@/lib/ai-workbench/action-scope";
import type { DiagnosticEvidence, DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";
import {
  applyParagraphEdit,
  hasRewriteBody,
  isAccountLimitError,
  syncDraftEditor,
  type DraftEditor,
  type ParagraphEdit,
  type TaskKind,
  type WorkbenchData,
  type WorkbenchJob,
} from "./model";
import { ChatGPTConnection, CHATGPT_USAGE_URL, type AccountExecution } from "./chatgpt-connection";
import { EvidencePanel } from "./evidence-panel";
import { ReportTask, type ReportSubmission } from "./report-task";
import { taskText } from "./task-messages";
import { useTrustedSources } from "./trusted-sources";
import { UsagePanel } from "./usage-panel";
import { activeTaskOf, usePollWhileActive } from "./use-site-tasks";
import { useWorkbenchForm, WorkbenchComposer } from "./workbench-composer";
import { WorkbenchResults } from "./workbench-result";
import { workbenchErrorText } from "./workbench-text";
import s from "./workbench.module.css";

/*
 * The Codex workbench: one task at a time for a site, its evidence and
 * account, and the drafts it returns. The form is workbench-composer.tsx,
 * the results workbench-result.tsx and the words workbench-text.ts.
 */

/** initialJobId: a task a link points at (?job=); it opens first and stays listed. */
export function CodexWorkbench({
  siteId,
  domain,
  initialData,
  initialSelection = {},
  actionScope,
  initialJobId,
}: {
  siteId: string;
  domain: string;
  initialData?: WorkbenchData;
  initialSelection?: DiagnosticSelection;
  actionScope?: ActionScope;
  initialJobId?: string;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<WorkbenchData | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectedRevision, setRejectedRevision] = useState<string | null>(null);
  const form = useWorkbenchForm(siteId);
  const trusted = useTrustedSources(siteId);
  const [previewSelection, setPreviewSelection] = useState<DiagnosticSelection>(initialSelection);
  const [diagnosis, setDiagnosis] = useState<DiagnosticEvidence | null>(null);
  const [pendingEvidence, setPendingEvidence] = useState<{ evidence: DiagnosticEvidence; kind: TaskKind } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId ?? null);
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [execution, setExecution] = useState<AccountExecution>({ provider: "CODEX_LOCAL", ready: false });
  const requestSequence = useRef(0);
  const mutating = useRef(false);
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant`;
  const listUrl = initialJobId ? `${endpoint}?job=${encodeURIComponent(initialJobId)}` : endpoint;
  const errorMessage = (message: string) => workbenchErrorText(message, t);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++requestSequence.current;
      setRefreshing(true);
      try {
        const response = await fetch(listUrl, { cache: "no-store", signal });
        const incoming = await response.json();
        if (!response.ok) throw new Error(incoming.error || t("Could not load the workbench.", "无法读取工作台。"));
        if (incoming.site?.id !== siteId || !Array.isArray(incoming.jobs))
          throw new Error(t("Site data did not match. Reload and try again.", "站点数据不匹配，请重新加载。"));
        if (signal?.aborted || sequence !== requestSequence.current) return;
        setData(incoming as WorkbenchData);
        // A linked task that is not this site's (or not a workbench task) falls back to the latest one.
        const found = (id: string) => (incoming.jobs as WorkbenchJob[]).some(job => job.id === id);
        setSelectedId(current => (current && (current !== initialJobId || found(current)) ? current : (incoming.jobs[0]?.id ?? null)));
        setError(null);
      } catch (cause) {
        if (signal?.aborted || sequence !== requestSequence.current) return;
        setError(
          cause instanceof Error ? cause.message : t("Could not load data. Your inputs have been preserved.", "读取失败，已保留输入内容。"),
        );
      } finally {
        if (!signal?.aborted && sequence === requestSequence.current) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [initialJobId, listUrl, siteId, t],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const { active: activeJob, blocking: blockingJob } = activeTaskOf(data);
  usePollWhileActive(activeJob, !!error, refresh, data);
  const selectedJob = data?.jobs.find(job => job.id === selectedId);
  useEffect(() => {
    setEditor(current => syncDraftEditor(current, selectedJob));
  }, [selectedJob]);
  const dirty = !!editor && editor.text !== editor.baseline;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function post(payload: Record<string, unknown>, actionName: string): Promise<Record<string, unknown> | null> {
    if (mutating.current) return null;
    mutating.current = true;
    setBusy(actionName);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t("The action could not be completed.", "操作未完成。"));
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("The request failed.", "请求失败。");
      if (message === "report_evidence_changed" && typeof payload.evidenceRevision === "string")
        setRejectedRevision(payload.evidenceRevision);
      setError(
        actionName === "start" && /fetch|network|JSON|Unexpected/i.test(message)
          ? t(
              "The response was interrupted. The task may already exist. Refresh task history before submitting again; your inputs are preserved.",
              "响应中断，任务可能已经创建。请先刷新任务记录再决定是否提交，输入内容已保留。",
            )
          : message,
      );
      return null;
    } finally {
      mutating.current = false;
      setBusy(null);
    }
  }
  async function startTask(input: Record<string, unknown>) {
    const result = await post(
      {
        ...input,
        action: "start",
        provider: execution.provider,
        ...(execution.provider === "CHATGPT_APP"
          ? { profileId: execution.profileId, model: execution.model, planOnlyConfirmed: execution.planOnlyConfirmed }
          : {}),
      },
      "start",
    );
    if (result && typeof result.jobId === "string") {
      if (dirty)
        setNotice(t("Task submitted. Save your current edits before opening its result.", "任务已提交。请先保存当前编辑，再打开新结果。"));
      else setSelectedId(result.jobId);
      await refresh();
    }
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!canGenerate) return;
    const { kind, title, instructions, keyword, language, clusterId, pageId, body, targetLocation, targetUrl } = form;
    // Localization and structured data take no brief and no diagnosis; structured data takes no pasted text.
    const tool = kind === "LOCALIZE_ARTICLE" || kind === "SCHEMA_MARKUP";
    await startTask({
      kind,
      title: title.trim(),
      instructions: instructions.trim(),
      keyword: keyword.trim(),
      language,
      ...(!tool && clusterId ? { clusterId } : {}),
      ...(pageId ? { pageId } : {}),
      ...(!tool && diagnosis ? { diagnosis: { ...diagnosis.selection, ...(diagnosis.crawl ? { crawlId: diagnosis.crawl.id } : {}) } } : {}),
      ...(kind === "SCHEMA_MARKUP" ? {} : { body: body.trim() }),
      ...(kind === "LOCALIZE_ARTICLE"
        ? { localization: { location: targetLocation, ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}) } }
        : {}),
    });
  }
  async function generateReport(submission: ReportSubmission) {
    await startTask({ ...submission, kind: "SEO_FIX_PLAN" });
  }
  async function saveDraft() {
    if (!editor || !dirty) return;
    const savedText = editor.text;
    const result = await post(
      { action: "saveDraft", jobId: editor.jobId, expectedUpdatedAt: editor.updatedAt, draftText: savedText },
      "save",
    );
    if (result && typeof result.updatedAt === "string") {
      setEditor(current =>
        current?.jobId === editor.jobId ? { ...current, baseline: savedText, updatedAt: result.updatedAt as string } : current,
      );
      setNotice(t("Draft saved locally. Nothing was published.", "草稿已保存到本机，尚未发布。"));
      await refresh();
    }
  }
  async function cancel(job: WorkbenchJob) {
    if (await post({ action: "cancel", jobId: job.id }, "cancel")) {
      setNotice(t("Cancellation requested. Account allowance already used is not refunded.", "已取消任务，已经使用的账号额度不会退回。"));
      await refresh();
    }
  }
  async function copyDraft() {
    if (!editor) return;
    try {
      await navigator.clipboard.writeText(editor.text);
      setNotice(t("Draft copied.", "已复制草稿。"));
    } catch {
      setError(t("Clipboard access failed. Select the draft text and copy it manually.", "无法访问剪贴板，请在草稿框内全选并复制。"));
    }
  }
  function downloadDraft() {
    if (!editor || !selectedJob) return;
    const blob = new Blob([editor.text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedJob.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "article"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }
  function chooseJob(id: string) {
    if (id === selectedId) return;
    if (dirty) setSwitchTo(id);
    else setSelectedId(id);
  }
  function chooseCluster(id: string) {
    setDiagnosis(null);
    form.setClusterId(id);
    const cluster = data?.clusters.find(item => item.id === id);
    if (cluster) {
      form.setTitle(cluster.title);
      form.setKeyword(cluster.keyword);
      form.setPageId(data?.pages.find(page => page.url === cluster.url)?.id ?? "");
    }
  }
  function choosePage(id: string) {
    setDiagnosis(null);
    form.setPageId(id);
    const page = data?.pages.find(item => item.id === id);
    if (page && !form.title.trim()) form.setTitle(page.title || page.url);
  }
  function useEvidence(evidence: DiagnosticEvidence, nextKind: TaskKind) {
    if (form.body.trim()) {
      setPendingEvidence({ evidence, kind: nextKind });
      return;
    }
    bindEvidence(evidence, nextKind);
  }
  function bindEvidence(evidence: DiagnosticEvidence, nextKind: TaskKind) {
    setPendingEvidence(null);
    setDiagnosis(evidence);
    form.setKind(nextKind);
    form.setPageId(evidence.page?.id ?? "");
    form.setClusterId("");
    form.setBody("");
    form.setTitle((evidence.page?.title || evidence.selection.url || evidence.selection.query || "").slice(0, 250));
    form.setKeyword((evidence.selection.query ?? "").slice(0, 250));
    setNotice(
      t("Evidence added to the task below. Review your requirements before generating.", "依据已带入下方任务。请检查要求后再生成。"),
    );
  }
  function applyEdit(edit: ParagraphEdit) {
    if (!editor || editor.jobId !== selectedJob?.id || selectedJob.kind !== "REWRITE_ARTICLE") return;
    const applied = applyParagraphEdit(editor.text, edit);
    if (!applied.ok) {
      setNotice(
        t("The source text has changed or is repeated. Review this passage manually.", "原文已变化或重复出现，请手动核对这段修改。"),
      );
      return;
    }
    setEditor(current => (current?.jobId === editor.jobId && current.text === editor.text ? { ...current, text: applied.text } : current));
    setNotice(t("Change applied to the local editor. Save the draft when ready.", "修改已采纳到本地编辑框，请保存草稿。"));
  }
  const savedPages = data?.pages ?? [];
  const pages =
    diagnosis?.page && !savedPages.some(page => page.id === diagnosis.page?.id)
      ? [
          ...savedPages,
          { id: diagnosis.page.id, url: diagnosis.page.url, title: diagnosis.page.title, hasBody: diagnosis.page.body.length >= 100 },
        ]
      : savedPages;
  const needsBody = form.kind === "REWRITE_ARTICLE" || form.kind === "LOCALIZE_ARTICLE";
  const enoughBody = !needsBody || hasRewriteBody(form.body, form.pageId, pages);
  const pageReady = form.kind !== "SCHEMA_MARKUP" || !!form.pageId;
  const canGenerate =
    !!data &&
    data.worker.online &&
    execution.ready &&
    !blockingJob &&
    !busy &&
    !error &&
    form.title.trim().length > 0 &&
    enoughBody &&
    pageReady;
  const copyResult = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("Copied.", "已复制。"));
    } catch {
      setError(t("Clipboard access failed. Select the text and copy it manually.", "无法访问剪贴板，请手动选中文字复制。"));
    }
  };

  return (
    <div className={s.workbench}>
      <header className={s.header}>
        <div className={s.headingGroup}>
          <span className={s.logo}>
            <Bot size={27} />
          </span>
          <div>
            <p className={s.eyebrow}>CODEX WORKBENCH</p>
            <h1>{t("Codex workbench", "Codex 工作台")}</h1>
          </div>
        </div>
        <div className={s.headerActions}>
          <span className={s.domain}>
            <Globe size={15} />
            {domain}
          </span>
          <button
            type="button"
            className={s.iconButton}
            aria-label={t("Refresh workbench", "刷新工作台")}
            disabled={refreshing || !!busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={18} className={refreshing ? s.spinning : ""} />
          </button>
        </div>
      </header>
      {actionScope ? (
        <div className={s.reportNav}>
          <Link href={`/sites/${encodeURIComponent(siteId)}/assistant`}>{t("Other workbench tasks", "其他工作台任务")}</Link>
        </div>
      ) : (
        <>
          <section className={s.intro}>
            <div>
              <p className={s.kicker}>{t("From a useful idea to a usable draft", "从一个想法，到一份可用的草稿")}</p>
              <h2>{t("Write. Improve. Make the next change clear.", "写好内容，让下一步修改更清楚。")}</h2>
              <p>{t("Choose a task, add your context, and review the result here.", "选一个任务，补充要求，在这里检查并编辑生成结果。")}</p>
            </div>
            <div className={s.connection}>
              <div>
                <span className={`${s.dot} ${data?.worker.online ? s.online : ""}`} />
                {loading
                  ? t("Checking local helper", "正在检查本机助手")
                  : data?.worker.online
                    ? t("Local helper online", "本机助手在线")
                    : t("Local helper offline", "本机助手未连接")}
              </div>
              <strong>{t("Drafts for your review", "生成草稿，由你审阅")}</strong>
              <span>{t("Choose your connection below.", "在下方选择新任务使用的连接。")}</span>
            </div>
          </section>
          <div className={s.boundary}>
            <ShieldCheck size={18} />
            <p>
              {t(
                "Results stay as local drafts for your review. Publishing and website changes are not performed by these tasks.",
                "结果保存为本地草稿，供你审阅。这些任务不会发布文章或修改网站。",
              )}
            </p>
          </div>
          <EvidencePanel
            siteId={siteId}
            selection={previewSelection}
            pages={pages}
            disabled={!!busy || !!blockingJob}
            onSelection={value => setPreviewSelection(value)}
            onUse={useEvidence}
          />
        </>
      )}
      {activeJob && !blockingJob && <p className={s.sourceHint}>{taskText.backgroundRunning(t)}</p>}
      {pendingEvidence && (
        <div className={s.help} role="alert">
          <div>
            <p>
              {t(
                "Your task contains pasted source text. Switching to the selected page replaces that text and the task title. Copy it first if you want to keep it.",
                "任务中已有粘贴的原文。切换到所选页面将替换这份原文和任务标题，如需保留请先复制。",
              )}
            </p>
            <div className={s.actions}>
              <button type="button" onClick={() => setPendingEvidence(null)}>
                {t("Keep current text", "保留当前原文")}
              </button>
              <button
                type="button"
                disabled={!!busy || !!activeJob}
                onClick={() => bindEvidence(pendingEvidence.evidence, pendingEvidence.kind)}
              >
                {t("Use selected page instead", "改用所选页面原文")}
              </button>
            </div>
          </div>
        </div>
      )}
      <ChatGPTConnection siteId={siteId} disabled={!!busy || !!blockingJob} onChange={setExecution} />
      {!actionScope && (
        <UsagePanel
          key={siteId}
          siteId={siteId}
          refreshKey={data?.jobs.map(job => `${job.id}:${job.status}:${job.updatedAt}`).join("|") ?? ""}
        />
      )}
      {error && error !== "report_evidence_changed" && (
        <div className={s.error} role="alert">
          <span>
            {errorMessage(error)}{" "}
            {isAccountLimitError(error) && (
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                {t("Manage usage", "管理用量")}
              </a>
            )}
          </span>
          <button type="button" onClick={() => void refresh()} disabled={refreshing}>
            {t("Refresh status", "刷新状态")}
          </button>
        </div>
      )}
      {notice && (
        <p className={s.notice} role="status">
          <Check size={17} />
          {notice}
        </p>
      )}
      {!loading && data && !data.worker.online && (
        <div className={s.help}>
          <CircleHelp size={18} />
          <div>
            {t(
              "Start the local content helper, then refresh. If login expired, complete the dedicated ChatGPT login on this computer. Do not paste passwords or API keys here.",
              "请先启动本机内容助手，再刷新状态。登录过期时，在本机完成专用 ChatGPT 登录。不要在任务中填写密码或 API Key。",
            )}
          </div>
        </div>
      )}
      <div className={s.workspace}>
        {actionScope ? (
          <div>
            {blockingJob && <p className={s.notice}>{t("A task is already running for this site.", "当前站点已有任务在处理。")}</p>}
            <ReportTask
              siteId={siteId}
              scope={actionScope}
              busy={!!busy}
              disabled={
                !data?.worker.online ||
                !execution.ready ||
                !!blockingJob ||
                (!!error && error !== "report_evidence_changed" && error !== "report_claim_too_large")
              }
              rejectedRevision={rejectedRevision}
              onStart={generateReport}
            />
          </div>
        ) : (
          <WorkbenchComposer
            siteId={siteId}
            form={form}
            clusters={data?.clusters ?? []}
            pages={pages}
            diagnosis={diagnosis}
            trusted={trusted}
            provider={execution.provider}
            busy={busy}
            blockingJob={blockingJob}
            enoughBody={enoughBody}
            pageReady={pageReady}
            canGenerate={canGenerate}
            onSubmit={generate}
            onClearDiagnosis={() => {
              setDiagnosis(null);
              form.setPageId("");
            }}
            onChooseCluster={chooseCluster}
            onChoosePage={choosePage}
          />
        )}
        <WorkbenchResults
          siteId={siteId}
          jobs={data?.jobs ?? []}
          loading={loading}
          selectedId={selectedId}
          selectedJob={selectedJob}
          switchTo={switchTo}
          editor={editor}
          dirty={dirty}
          busy={busy}
          trusted={trusted}
          onChooseJob={chooseJob}
          onKeepEditing={() => setSwitchTo(null)}
          onDiscardEdits={() => {
            setSelectedId(switchTo);
            setSwitchTo(null);
          }}
          onCancel={job => void cancel(job)}
          onEditorText={text => setEditor(current => (current ? { ...current, text } : current))}
          onSaveDraft={() => void saveDraft()}
          onCopyDraft={() => void copyDraft()}
          onDownloadDraft={downloadDraft}
          onApplyEdit={applyEdit}
          onCopyResult={text => void copyResult(text)}
        />
      </div>
      <footer className={s.footer}>
        <span>
          <ShieldCheck size={16} />
          {t("Review facts and publish from your own website when ready.", "核实内容后，再到你的网站后台发布。")}
        </span>
        <Link href={`/sites/${siteId}/content`}>
          {t("Back to content planning", "返回内容规划")}
          <ArrowRight size={14} />
        </Link>
      </footer>
    </div>
  );
}
