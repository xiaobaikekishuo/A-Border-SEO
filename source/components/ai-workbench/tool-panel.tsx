"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Sparkles, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import { ChatGPTConnection, CHATGPT_USAGE_URL } from "./chatgpt-connection";
import { isActiveTool, toolErrorKind, type ToolJob, type ToolWorkspace } from "./tool-model";
import { taskText } from "./task-messages";
import { useSiteTasks } from "./use-site-tasks";
import { toolAnchor } from "@/lib/ai-workbench/job-link";
import k from "@/components/research/keyword-ai-panel.module.css";

/** A readable message for a server or task error of a structured Codex task. */
export function toolErrorText(message: string, t: Translator): string {
  switch (toolErrorKind(message)) {
    case "too_large":
      return t(
        "The selected material exceeds what the local helper takes in one task. Choose fewer pages, queries or prospects, or shorten the text.",
        "所选内容超过本机助手单个任务的长度上限。请减少页面、搜索词、外链机会或缩短原文后再试。",
      );
    case "no_search_data":
      return t(
        "The selected pages have no saved Search Console rows in the last 28 days. Sync Search Console first.",
        "所选页面在最近 28 天没有已保存的 Search Console 数据，请先同步。",
      );
    case "few_queries":
      return t(
        "Fewer than 10 queries had impressions in the last 28 days. Sync Search Console, then group them.",
        "最近 28 天有曝光的搜索词不足 10 个。请先同步 Search Console 再分组。",
      );
    case "manus_task":
      return t("That Manus link prospect task is not finished or no longer exists.", "这个 Manus 外链调研任务还没完成，或已不存在。");
    case "rows_changed":
      return t("The chosen prospects changed. Reload them and choose again.", "所选外链机会已变化，请刷新后重新选择。");
    case "unusable":
      return t(
        "Codex returned a result that did not pass the checks. Your settings are kept; you can try again.",
        "Codex 返回的结果没有通过检查。设置已保留，可以再试一次。",
      );
    case "canceled":
      return t("Canceled. Allowance already used is not refunded.", "已取消，已使用的账号额度不会退回。");
    case "usage":
      return t(
        "This account reached a usage limit. Check ChatGPT usage, then start a new task when it is available again.",
        "此账号已达到用量上限。请查看 ChatGPT 用量，恢复后再新建任务。",
      );
    case "timeout":
      return t("The task timed out. No automatic retry was sent.", "任务超时，系统没有自动重试。");
    case "busy":
      return t("This site has an active task. Wait for it to finish or cancel it first.", "此站点已有进行中的任务，请等待完成或先取消。");
    case "offline":
      return taskText.helperOffline(t);
    default:
      return message;
  }
}

/**
 * Tasks of one structured kind for a site (use-site-tasks.ts), started with
 * the account the connection panel chose. initialJobId: a task a link points
 * at (?job=); it opens first and stays listed.
 */
export function useToolTasks(siteId: string, kind: string, initialJobId?: string) {
  const { t } = useI18n();
  const tasks = useSiteTasks<ToolJob, ToolWorkspace>({ siteId, kind, initialJobId });
  const { execution } = tasks;
  const ready =
    tasks.online &&
    execution.ready &&
    !tasks.blocking &&
    !tasks.busy &&
    !tasks.loading &&
    !tasks.refreshing &&
    !tasks.loadError &&
    !tasks.uncertain;
  async function start(payload: Record<string, unknown>) {
    if (!ready) return false;
    const account =
      execution.provider === "CHATGPT_APP"
        ? { profileId: execution.profileId, model: execution.model, planOnlyConfirmed: execution.planOnlyConfirmed }
        : {};
    return tasks.start(
      { ...payload, kind, action: "start", provider: execution.provider, ...account },
      {
        errorText: message => toolErrorText(message, t),
        notice: t(
          "Task submitted. Results are saved here for your review; nothing on the website changes.",
          "任务已提交。结果保存在这里供你审阅，不会修改网站。",
        ),
      },
    );
  }
  return { ...tasks, ready, start };
}

export type ToolTasks = ReturnType<typeof useToolTasks>;

/**
 * The frame of a structured task panel: what it does, the account it uses,
 * the form, the task history and the selected result.
 */
export function ToolPanel({
  siteId,
  api,
  kicker,
  title,
  description,
  label,
  returnPage,
  form,
  result,
}: {
  siteId: string;
  api: ToolTasks;
  kicker: string;
  title: string;
  description: ReactNode;
  label: string;
  returnPage: "assistant" | "opportunities" | "content" | "backlinks";
  form: ReactNode;
  result: (job: ToolJob) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const status = (job: ToolJob) =>
    ({
      QUEUED: t("Queued", "排队中"),
      RUNNING: t("Generating", "生成中"),
      SUCCEEDED: t("Ready", "已完成"),
      FAILED: job.error?.startsWith("Canceled by user") ? t("Canceled", "已取消") : t("Failed", "未完成"),
    })[job.status];
  const selected = api.selected;
  return (
    <section className={k.panel} aria-label={label} id={toolAnchor(api.kind)}>
      <header className={k.intro}>
        <div>
          <div className={k.kicker}>
            <Sparkles size={16} />
            {kicker}
          </div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <Link href={`/sites/${encodeURIComponent(siteId)}/assistant`}>{t("Workbench and usage →", "工作台与用量统计 →")}</Link>
      </header>
      <details className={k.connection}>
        <summary>{t("ChatGPT connection", "ChatGPT 账号连接")}</summary>
        <ChatGPTConnection siteId={siteId} disabled={api.busy || !!api.blocking} onChange={api.setExecution} returnPage={returnPage} />
      </details>
      {(api.error || api.loadError) && (
        <p className={k.error} role="alert">
          {api.error || api.loadError}{" "}
          {toolErrorKind(api.error) === "usage" && (
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              {t("Manage usage", "管理用量")}
            </a>
          )}
        </p>
      )}
      {api.notice && (
        <p className={k.notice} role="status">
          {api.notice}
        </p>
      )}
      <div className={k.layout}>
        <div className={k.card}>
          {form}
          {api.blocking && (
            <p className={`${k.muted} mt-3`}>
              {t("This site has an active task. Wait for it to finish or cancel it first.", "此站点已有进行中的任务，请等待完成或先取消。")}
            </p>
          )}
          {api.active && !api.blocking && <p className={`${k.muted} mt-3`}>{taskText.backgroundRunning(t)}</p>}
          {!api.loading && api.data && !api.data.worker.online && <p className={`${k.error} mt-3`}>{taskText.helperOffline(t)}</p>}
          {!api.execution.ready && (
            <p className={`${k.muted} mt-3`}>
              {t("Sign in to ChatGPT in the connection above before generating.", "生成前请先在上方完成 ChatGPT 账号连接。")}
            </p>
          )}
        </div>
        <aside className={k.card}>
          <div className={k.header}>
            <h3>{t("Saved tasks", "任务记录")}</h3>
            <button
              type="button"
              className={k.secondary}
              aria-label={t("Refresh tasks", "刷新任务")}
              disabled={api.refreshing || api.busy}
              onClick={() => void api.refresh()}
            >
              <RefreshCw size={15} className={api.refreshing ? k.spinner : ""} />
            </button>
          </div>
          <p className={k.muted}>
            {t(
              "The latest 20 tasks of this kind. A failed task is never retried automatically.",
              "本站最近 20 条同类任务，失败不会自动重试。",
            )}
          </p>
          <label className={`${k.field} mt-4`}>
            {t("Task", "任务")}
            <select value={selected?.id ?? ""} disabled={!api.jobs.length} onChange={event => api.setSelectedId(event.target.value)}>
              <option value="" disabled>
                {api.loading ? t("Loading…", "正在读取…") : t("No tasks yet", "还没有任务")}
              </option>
              {api.jobs.map(job => (
                <option key={job.id} value={job.id}>
                  {status(job)} · {job.title}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <p className={k.status}>
                {isActiveTool(selected) && <Loader2 size={15} className={k.spinner} />}
                {status(selected)}
              </p>
              <p className={k.muted}>{new Date(selected.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</p>
              {selected.error && (
                <p role="alert" className={`${k.error} mt-3`}>
                  {toolErrorText(selected.error, t)}
                </p>
              )}
              {isActiveTool(selected) && (
                <button type="button" className={`${k.secondary} mt-3`} disabled={api.busy} onClick={() => void api.cancel(selected)}>
                  <Square size={13} />
                  {t("Cancel task", "取消任务")}
                </button>
              )}
            </>
          )}
        </aside>
      </div>
      {selected?.status === "SUCCEEDED" && selected.result && (
        <section className={k.card} aria-label={t("Result", "结果")}>
          {result(selected)}
        </section>
      )}
    </section>
  );
}

/** Copies a text, then says so in the panel. */
export async function copyText(api: ToolTasks, text: string, t: Translator) {
  try {
    await navigator.clipboard.writeText(text);
    api.setNotice(t("Copied.", "已复制。"));
  } catch {
    api.setError(t("Clipboard access failed. Select the text and copy it manually.", "无法访问剪贴板，请手动选中文字复制。"));
  }
}
