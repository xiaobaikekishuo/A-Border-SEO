"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Download, ExternalLink, FileText, Loader2, RefreshCw, Telescope } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { ManusKeywordTask, ManusTaskList, ManusTaskStatus } from "@/lib/manus/tasks";
import { ManusKeywordCandidates } from "./manus-keyword-candidates";

const settingsLink = "/settings?connect=manus#connection-manus";
const fieldClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function taskStatus(status: ManusTaskStatus, t: Translator) {
  switch (status) {
    case "submitting": return t("Submitting", "提交中");
    case "unknown": return t("Submission unconfirmed", "提交结果待核实");
    case "pending": return t("Queued", "排队中");
    case "running": return t("Researching", "研究中");
    case "waiting": return t("Needs input", "等待补充信息");
    case "completed": return t("Completed", "已完成");
    case "failed": return t("Failed", "失败");
  }
}

function errorText(code: string, t: Translator) {
  switch (code) {
    case "missing_key":
    case "unreadable_key":
    case "unauthorized": return t("Check or replace your Manus API key in Settings.", "请到设置中检查或替换 Manus API 密钥。");
    case "insufficient_credits": return t("Check the credit balance in your Manus account.", "请检查 Manus 账号的积分余额。");
    case "rate_limited": return t("Manus has reached its request limit. Try again later.", "已达到 Manus 请求频率上限，请稍后再试。");
    case "forbidden": return t("Check that the saved key has access to this task in Manus.", "请检查已保存的密钥是否有权在 Manus 访问该任务。");
    case "not_found": return t("Manus could not find this task. Check the task in your Manus account.", "Manus 未找到该任务，请在 Manus 账号中核对。");
    case "invalid_input": return t("Check your seed keywords, market and language.", "请检查种子关键词、目标市场和输出语言。");
    case "history": return t("Could not load saved tasks. Refresh the list to try again.", "未能加载已保存任务，请刷新列表重试。");
    case "submission": return t("The submission could not be confirmed. Refresh the list and check Manus before submitting again.", "暂时无法确认是否已提交。再次提交前，请刷新列表并核对 Manus 账号中的任务。");
    case "session":
    case "sign_in_required": return t("Sign in again to access this site.", "请重新登录以访问此站点。");
    case "site_not_found": return t("This site is no longer available to your account.", "当前账号无法访问该站点。");
    default: return t("Manus could not complete the request. Check the saved task and your Manus account.", "Manus 未能完成请求，请检查已保存的任务与 Manus 账号。");
  }
}

function httpsLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function readableSummary(summary: string, t: Translator) {
  const fileName = (path: string) => {
    const basename = path.split("/").pop();
    return basename ? t("{name} (file in Manus)", "{name}（Manus 内的文件）", { name: basename }) : t("File in Manus", "Manus 内的文件");
  };
  return summary.replace(/\[[^\]\n]*\]\(\s*<?((?:sandbox:\/|\/home\/ubuntu\/|\/mnt\/data\/)[^)>\n]+)>?\s*\)/gi, (_, path: string) => fileName(path.trim()))
    .replace(/(?:sandbox:\/|\/home\/ubuntu\/|\/mnt\/data\/)[^\s\u3000\u3001\u3002，；：！”’)`\]]+/gi, fileName);
}

function ResearchSummary({ siteId, task, connected, taskUrl }: {
  siteId: string; task: ManusKeywordTask; connected: boolean; taskUrl: string | null;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<{ filename: string; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function toggleReport() {
    if (report) { setOpen(!open); return; }
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/manus-keywords/${encodeURIComponent(task.id)}/report`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) { setError(data.error || "report_failed"); return; }
      if (typeof data.text !== "string" || typeof data.filename !== "string") throw new Error();
      setReport({ filename: data.filename, text: data.text });
      setOpen(true);
    } catch { setError("report_failed"); }
    finally { setBusy(false); pending.current = false; }
  }
  const reportId = `manus-report-${task.id}`;
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-semibold">{open ? t("Full research report", "完整研究报告") : t("Research summary", "研究摘要")}</h4>
      {task.status === "completed" && <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })}
        disabled={busy || (!report && !connected)} aria-expanded={open} aria-controls={reportId} onClick={() => void toggleReport()}>
        {busy ? <Loader2 className="animate-spin" /> : <FileText />}
        {open ? t("Hide full report", "收起完整报告") : t("Read full report", "阅读完整报告")}
      </button>}
    </div>
    {error && <p role="alert" className="text-sm text-muted-foreground">
      {error === "no_report" ? t("No Markdown report was found.", "未找到 Markdown 报告。") : t("Could not read the full report.", "未能读取完整报告。")}
      {taskUrl && <> <a className="text-link" href={taskUrl} target="_blank" rel="noopener noreferrer">{t("View files in the private Manus task", "前往 Manus 私有任务查看文件")}</a></>}
    </p>}
    {!open && task.result && <p className="whitespace-pre-wrap break-words leading-6">{readableSummary(task.result, t)}</p>}
    <div hidden={!open} id={reportId}>
      {report && <><p className="mb-2 break-words text-xs text-muted-foreground">{report.filename}</p>
        <pre tabIndex={0} className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-soft p-4 font-sans text-sm leading-6 select-text">{report.text}</pre></>}
    </div>
  </section>;
}

export function ManusTaskResult({ task, siteId, connected, busy, updating, onUpdate }: {
  task: ManusKeywordTask; siteId: string; connected: boolean; busy: boolean; updating: boolean; onUpdate: () => void;
}) {
  const { t, locale } = useI18n();
  const taskUrl = httpsLink(task.taskUrl);
  return <div className="space-y-4 border-t border-border-soft px-4 py-4 text-sm">
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      <div><dt className="text-muted-foreground">{t("Output language", "输出语言")}</dt><dd>{task.input.language}</dd></div>
      {task.input.audience && <div><dt className="text-muted-foreground">{t("Target market or audience", "目标市场或受众")}</dt><dd className="break-words">{task.input.audience}</dd></div>}
      <div><dt className="text-muted-foreground">{t("Last update", "上次更新")}</dt><dd>{formatDay(task.updatedAt, { locale, time: true, year: true })}</dd></div>
    </dl>
    {task.status === "unknown" && <p className="text-warning">{t("Check your task history in Manus before starting another paid task.", "请先在 Manus 账号中核对任务记录，再决定是否新建付费任务。")}</p>}
    {task.status === "waiting" && <p>{t("Open the private task in Manus to provide the requested input.", "请打开 Manus 私有任务，补充所需信息。")}</p>}
    {task.errorCode && task.status !== "unknown" && <p className="text-danger">{errorText(task.errorCode, t)}</p>}
    {task.status === "completed" && <ManusKeywordCandidates key={`${siteId}/${task.id}`} siteId={siteId} taskId={task.id} connected={connected} />}
    {task.files.length > 0 && <section>
      <h4 className="mb-2 font-semibold">{t("Research files", "研究文件")}</h4>
      <ul className="space-y-2">{task.files.map((file, index) => {
        const href = httpsLink(file.url);
        return href && <li key={index}><a className="inline-flex items-center gap-2 break-all text-link" href={href} target="_blank" rel="noopener noreferrer"><Download className="size-4 shrink-0" />{file.name}</a></li>;
      })}</ul>
      <p className="mt-2 text-xs text-muted-foreground">{t("If a download link expires, update the result to renew it.", "如下载链接已过期，可更新结果以获取新链接。")}</p>
    </section>}
    <div className="flex flex-wrap items-center gap-3">
      {task.refreshable && <button type="button" disabled={!connected || busy} onClick={onUpdate} className={buttonVariants({ variant: "outline", size: "sm" })}>
        <RefreshCw className={updating ? "size-4 animate-spin" : "size-4"} />{t("Update result from Manus", "从 Manus 更新结果")}
      </button>}
      {taskUrl && <a href={taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-link">{t("Open private task in Manus", "打开 Manus 私有任务")}<ExternalLink className="size-3.5" /></a>}
    </div>
    {(task.result || task.status === "completed") && <ResearchSummary key={`${siteId}/${task.id}`} siteId={siteId} task={task} connected={connected} taskUrl={taskUrl} />}
  </div>;
}

// randomUUID needs HTTPS. LAN deployments can also generate a v4 UUID with getRandomValues.
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function ManusKeywordPanel({ siteId }: { siteId: string }) {
  const { t, locale } = useI18n();
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/manus-keywords`;
  const [seedsText, setSeedsText] = useState("");
  const [audience, setAudience] = useState("");
  const [language, setLanguage] = useState(locale === "zh" ? "简体中文" : "English");
  const [confirmed, setConfirmed] = useState(false);
  const [history, setHistory] = useState<ManusTaskList | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("list");
  const [error, setError] = useState("");
  const actionLock = useRef(false);
  const lastAttempt = useRef<{ id: string; payload: string } | null>(null);
  const seeds = seedsText.split(/\r?\n/).map(seed => seed.trim()).filter(Boolean);
  const invalidSeeds = seeds.length > 20 || seeds.some(seed => seed.length > 80);
  const ready = !!history?.connected && !busy && !invalidSeeds && seeds.length > 0 && language.trim() && confirmed;

  const loadHistory = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy("list");
    setError("");
    try {
      const url = cursor ? `${endpoint}?cursor=${encodeURIComponent(cursor)}` : endpoint;
      const res = await fetch(url, { cache: "no-store", signal });
      if (!res.ok) throw new Error(res.status === 401 ? "session" : "history");
      const list: ManusTaskList = await res.json();
      if (!Array.isArray(list.tasks) || typeof list.connected !== "boolean") throw new Error("history");
      if (signal?.aborted) return;
      setHistory(previous => ({
        ...list,
        tasks: cursor && previous ? [...previous.tasks, ...list.tasks.filter(task => !previous.tasks.some(saved => saved.id === task.id))] : list.tasks,
      }));
      if (!cursor) setExpandedId(id => list.tasks.some(task => task.id === id) ? id : list.tasks[0]?.id ?? null);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error && cause.message === "session" ? "session" : "history");
    } finally {
      if (!signal?.aborted) { actionLock.current = false; setBusy(null); }
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(undefined, controller.signal);
    return () => { controller.abort(); actionLock.current = false; };
  }, [loadHistory]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || actionLock.current) return;
    actionLock.current = true;
    setBusy("create");
    setError("");
    setConfirmed(false);
    try {
      const input = { seeds, audience: audience.trim(), language: language.trim() };
      const payload = JSON.stringify(input);
      // A lost response must not turn a manual retry into a second paid creation.
      if (lastAttempt.current?.payload !== payload) lastAttempt.current = { id: newRequestId(), payload };
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true, requestId: lastAttempt.current.id }),
      });
      const data = await res.json();
      if (!res.ok && !data.task) { setError(data.error || "submission"); return; }
      if (!data.task?.id) throw new Error("submission");
      const task: ManusKeywordTask = data.task;
      setHistory(previous => previous && ({ ...previous, tasks: [task, ...previous.tasks.filter(item => item.id !== task.id)] }));
      setExpandedId(task.id);
      lastAttempt.current = null;
    } catch {
      setError("submission");
    } finally { actionLock.current = false; setBusy(null); }
  }

  async function updateResult(id: string) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(id);
    setError("");
    try {
      const res = await fetch(`${endpoint}/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.task?.id !== id) { setError(data.error || "upstream"); return; }
      setHistory(previous => previous && ({ ...previous, tasks: previous.tasks.map(task => task.id === id ? data.task : task) }));
    } catch {
      setError("network");
    } finally { actionLock.current = false; setBusy(null); }
  }

  return <div className="space-y-5">
    <section className="panel space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-strong">{t("Research with Manus", "使用 Manus 研究关键词")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("Ask Manus to research public sources and return a summary and an Excel workbook with keyword ideas, search intent and sources.", "让 Manus 调研公开资料，提供研究摘要和 Excel 工作簿，列出关键词建议、搜索意图及来源。")}</p>
        </div>
        <Link href={settingsLink} className="text-sm text-link">{history?.connected ? t("Manage Manus API key", "管理 Manus API 密钥") : t("Connect Manus in Settings", "在设置中连接 Manus")}</Link>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <label className="grid gap-1.5 text-sm font-medium">
          {t("Seed keywords", "种子关键词")}
          <textarea rows={3} className={fieldClass} required value={seedsText} disabled={busy === "create"} onChange={e => { setSeedsText(e.target.value); setConfirmed(false); }} />
          <span className={invalidSeeds ? "text-xs text-danger" : "text-xs text-muted-foreground"}>{t("Enter one keyword per line, up to 20 keywords and 80 characters per keyword.", "每行一个关键词，最多 20 个，每个最多 80 个字符。")}</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">{t("Target market or audience (optional)", "目标市场或受众（选填）")}
            <input className={fieldClass} maxLength={300} value={audience} disabled={busy === "create"} onChange={e => { setAudience(e.target.value); setConfirmed(false); }} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">{t("Output language", "输出语言")}
            <input className={fieldClass} required maxLength={80} value={language} disabled={busy === "create"} onChange={e => { setLanguage(e.target.value); setConfirmed(false); }} />
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={confirmed} disabled={busy === "create" || !history?.connected} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />
          {t("I agree to send these inputs to Manus and use my Manus account credits for this task.", "我同意将以上输入发送至 Manus，并使用我的 Manus 账号积分执行本次研究。")}
        </label>
        <button type="submit" disabled={!ready} className={buttonVariants()}>{busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Telescope className="size-4" />}{t("Start Manus research", "开始 Manus 研究")}</button>
      </form>
    </section>
    {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">{errorText(error, t)}</p>}
    <section className="panel space-y-4 p-5 sm:p-6" aria-busy={!!busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-text-strong">{t("Saved Manus tasks", "已保存的 Manus 任务")}</h2>
        <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={!!busy} onClick={() => void loadHistory()}>
          <RefreshCw className={busy === "list" ? "size-4 animate-spin" : "size-4"} />{t("Refresh list", "刷新列表")}
        </button>
      </div>
      {!history && busy === "list" && <p role="status" className="text-sm text-muted-foreground">{t("Loading saved tasks…", "正在读取已保存任务…")}</p>}
      {history?.tasks.length === 0 && <p className="text-sm text-muted-foreground">{t("This site has no saved Manus tasks yet.", "此站点尚无 Manus 任务记录。")}</p>}
      {history?.tasks.map(task => <article key={task.id} className="overflow-hidden rounded-lg border border-border">
        <button type="button" aria-expanded={expandedId === task.id} aria-controls={`manus-result-${task.id}`} onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
          className="flex w-full flex-wrap items-center justify-between gap-2 bg-bg-soft px-4 py-3 text-left text-sm hover:bg-muted">
          <span className="min-w-0 flex-1 break-words font-medium text-text-strong">{task.input.seeds.join(" · ")}</span>
          <time dateTime={task.createdAt} className="font-data text-xs text-muted-foreground">{formatDay(task.createdAt, { locale, time: true })}</time>
          <span className="rounded-md border border-border px-2 py-1 text-xs">{taskStatus(task.status, t)}</span>
        </button>
        <div id={`manus-result-${task.id}`} hidden={expandedId !== task.id}>
          {expandedId === task.id && <ManusTaskResult task={task} siteId={siteId} connected={history.connected} busy={!!busy} updating={busy === task.id} onUpdate={() => void updateResult(task.id)} />}
        </div>
      </article>)}
      {history?.nextCursor && <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={!!busy} onClick={() => void loadHistory(history.nextCursor!)}>
        {t("Load older tasks", "加载更早的任务")}
      </button>}
    </section>
  </div>;
}
