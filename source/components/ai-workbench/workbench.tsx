"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Check, CircleHelp, Copy, Download, FilePenLine, FileText, Globe, Loader2, PencilLine, RefreshCw, Save, ShieldCheck, Sparkles, Square, Wrench } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { applyParagraphEdit, hasRewriteBody, isAccountLimitError, isActiveJob, syncDraftEditor, type DraftEditor, type ParagraphEdit, type TaskKind, type WorkbenchData, type WorkbenchJob } from "./model";
import type { DiagnosticEvidence, DiagnosticSelection } from "@/lib/ai-workbench/diagnostic-types";
import { EvidencePanel, TaskEvidence } from "./evidence-panel";
import { ParagraphReview } from "./paragraph-review";
import { ChatGPTConnection, CHATGPT_USAGE_URL, type AccountExecution } from "./chatgpt-connection";
import { UsagePanel } from "./usage-panel";
import s from "./workbench.module.css";

export function CodexWorkbench({ siteId, domain, initialData, initialSelection = {} }: { siteId: string; domain: string; initialData?: WorkbenchData; initialSelection?: DiagnosticSelection }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<WorkbenchData | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<TaskKind>("WRITE_ARTICLE");
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState<"zh-CN" | "en">("zh-CN");
  const [clusterId, setClusterId] = useState("");
  const [pageId, setPageId] = useState("");
  const [body, setBody] = useState("");
  const [previewSelection, setPreviewSelection] = useState<DiagnosticSelection>(initialSelection);
  const [diagnosis, setDiagnosis] = useState<DiagnosticEvidence | null>(null);
  const [pendingEvidence, setPendingEvidence] = useState<{ evidence: DiagnosticEvidence; kind: TaskKind } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [execution, setExecution] = useState<AccountExecution>({ provider: "CODEX_LOCAL", ready: false });
  const requestSequence = useRef(0);
  const mutating = useRef(false);
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant`;

  const tasks = [
    { kind: "WRITE_ARTICLE" as const, icon: FilePenLine, title: t("Write an article", "写文章全文"), description: t("Turn a topic or brief into a complete draft.", "从选题或简报出发，写成完整草稿。") },
    { kind: "REWRITE_ARTICLE" as const, icon: PencilLine, title: t("Improve an article", "改写已有文章"), description: t("Use the original text to improve structure and clarity.", "结合原文，改进结构与内容表达。") },
    { kind: "SEO_FIX_PLAN" as const, icon: Wrench, title: t("Plan SEO fixes", "生成修复方案"), description: t("Translate audit findings into concrete next steps.", "把审计问题变成可检查的修改建议。") },
  ];
  const statusName = (job: WorkbenchJob) => ({ QUEUED: t("Queued", "排队中"), RUNNING: t("Generating", "生成中"), SUCCEEDED: t("Draft ready", "草稿就绪"), FAILED: job.error?.startsWith("Canceled by user") ? t("Canceled", "已取消") : t("Failed", "未完成") })[job.status];
  const kindName = (jobKind: TaskKind) => tasks.find(task => task.kind === jobKind)?.title ?? jobKind;
  function errorMessage(message: string) {
    if (/crawl changed|latest completed crawl|does not match the diagnosis|Choose a page from the saved evidence/i.test(message)) return t("Page evidence changed or no longer matches the selected source. Refresh the preview, select the page, and bring it into the task again. Your task text is preserved.", "页面依据已变化或与所选来源不一致。请刷新预览、选择页面并重新带入任务，任务输入仍保留。");
    if (/Paragraph (source|edits)|Applying paragraph edits/i.test(message)) return t("The proposed paragraph changes could not be matched safely to the source. Review the saved task before trying again.", "建议的段落修改无法可靠对应原文，请检查已保存的任务后再重试。");
    if (isAccountLimitError(message)) return t("This connection reached a usage limit. Check ChatGPT usage and app limits, then start a new task when available. No other connection or API key is used automatically.", "此连接已达到使用限制。请查看 ChatGPT 用量及应用上限，恢复后再新建任务。不会自动切换其他连接或 API Key。");
    if (/chatgpt_app|chatgpt_connection|subscription_sharing|plan_permission/i.test(message)) return t("The ChatGPT app connection needs attention. Check its status above and reconnect or refresh its models before starting another task.", "ChatGPT 应用连接需要处理。请检查上方状态，重新授权或刷新模型后再手动新建任务。");
    if (/chatgpt_login_required/i.test(message)) return t("Sign in to the dedicated local Codex account, restart the content helper, then refresh this page.", "请在本机完成专用 Codex 账号登录，重启内容助手后刷新页面。");
    if (/Canceled by user/i.test(message)) return t("Canceled. The local helper stops at its next heartbeat, normally within 30 seconds. Already used account allowance is not refunded.", "已取消。本机助手将在下次心跳时停止，通常不超过 30 秒；已用账号额度不会退回。");
    if (/timed out|generation_timeout/i.test(message)) return t("This task timed out. Review its state before starting another task; no automatic retry was sent.", "任务已超时。请核对状态后再新建任务，系统没有自动重试。");
    if (/worker.*offline|helper.*offline|worker.*online/i.test(message)) return t("Start the local content helper and refresh this page before generating.", "请先启动本机内容助手，刷新页面后再生成。");
    if (/changed|conflict|stale|updated/i.test(message)) return t("This draft changed elsewhere. Your unsaved text is still here. Copy it before reloading the latest version.", "此草稿已在其他地方更新。未保存的文字仍保留，请先复制，再重新加载最新版本。");
    if (/codex_generation_failed|generation_failed|invalid_model_output/i.test(message)) return t("Codex did not return a usable draft. Your request is preserved; review it before starting a new task.", "Codex 没有返回可用草稿。任务要求仍保留，请检查后再手动生成。");
    return message;
  }
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setRefreshing(true);
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      const incoming = await response.json();
      if (!response.ok) throw new Error(incoming.error || t("Could not load the workbench.", "无法读取工作台。"));
      if (incoming.site?.id !== siteId || !Array.isArray(incoming.jobs)) throw new Error(t("Site data did not match. Reload and try again.", "站点数据不匹配，请重新加载。"));
      if (signal?.aborted || sequence !== requestSequence.current) return;
      setData(incoming as WorkbenchData);
      setSelectedId(current => current ?? incoming.jobs[0]?.id ?? null);
      setError(null);
    } catch (cause) {
      if (signal?.aborted || sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : t("Could not load data. Your inputs have been preserved.", "读取失败，已保留输入内容。"));
    } finally {
      if (!signal?.aborted && sequence === requestSequence.current) { setRefreshing(false); setLoading(false); }
    }
  }, [endpoint, siteId, t]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  const activeJob = data?.jobs.find(isActiveJob) ?? data?.activeTask;
  useEffect(() => {
    if (!activeJob || error) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void refresh(controller.signal); }, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeJob, data, error, refresh]);
  const selectedJob = data?.jobs.find(job => job.id === selectedId);
  useEffect(() => { setEditor(current => syncDraftEditor(current, selectedJob)); }, [selectedJob]);
  const dirty = !!editor && editor.text !== editor.baseline;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function post(payload: Record<string, unknown>, actionName: string): Promise<Record<string, unknown> | null> {
    if (mutating.current) return null;
    mutating.current = true; setBusy(actionName); setError(null); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t("The action could not be completed.", "操作未完成。"));
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("The request failed.", "请求失败。");
      setError(actionName === "start" && /fetch|network|JSON|Unexpected/i.test(message) ? t("The response was interrupted. The task may already exist. Refresh task history before submitting again; your inputs are preserved.", "响应中断，任务可能已经创建。请先刷新任务记录再决定是否提交，输入内容已保留。") : message);
      return null;
    } finally { mutating.current = false; setBusy(null); }
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!canGenerate) return;
    const result = await post({ action: "start", kind, title: title.trim(), instructions: instructions.trim(), keyword: keyword.trim(), language,
      provider: execution.provider, ...(execution.provider === "CHATGPT_APP" ? { profileId: execution.profileId, model: execution.model, planOnlyConfirmed: execution.planOnlyConfirmed } : {}),
      ...(clusterId ? { clusterId } : {}), ...(pageId ? { pageId } : {}),
      ...(diagnosis ? { diagnosis: { ...diagnosis.selection, ...(diagnosis.crawl ? { crawlId: diagnosis.crawl.id } : {}) } } : {}), body: body.trim() }, "start");
    if (result && typeof result.jobId === "string") {
      if (dirty) setNotice(t("Task submitted. Save your current edits before opening its result.", "任务已提交。请先保存当前编辑，再打开新结果。"));
      else setSelectedId(result.jobId);
      await refresh();
    }
  }
  async function saveDraft() {
    if (!editor || !dirty) return;
    const savedText = editor.text;
    const result = await post({ action: "saveDraft", jobId: editor.jobId, expectedUpdatedAt: editor.updatedAt, draftText: savedText }, "save");
    if (result && typeof result.updatedAt === "string") {
      setEditor(current => current?.jobId === editor.jobId ? { ...current, baseline: savedText, updatedAt: result.updatedAt as string } : current);
      setNotice(t("Draft saved locally. Nothing was published.", "草稿已保存到本机，尚未发布。"));
      await refresh();
    }
  }
  async function cancel(job: WorkbenchJob) {
    if (await post({ action: "cancel", jobId: job.id }, "cancel")) { setNotice(t("Cancellation requested. Account allowance already used is not refunded.", "已取消任务，已经使用的账号额度不会退回。")); await refresh(); }
  }
  async function copyDraft() {
    if (!editor) return;
    try { await navigator.clipboard.writeText(editor.text); setNotice(t("Draft copied.", "已复制草稿。")); }
    catch { setError(t("Clipboard access failed. Select the draft text and copy it manually.", "无法访问剪贴板，请在草稿框内全选并复制。")); }
  }
  function downloadDraft() {
    if (!editor || !selectedJob) return;
    const blob = new Blob([editor.text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${(selectedJob.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "article")}.md`;
    link.click(); URL.revokeObjectURL(url);
  }
  function chooseJob(id: string) { if (id === selectedId) return; if (dirty) setSwitchTo(id); else setSelectedId(id); }
  function chooseCluster(id: string) {
    setDiagnosis(null);
    setClusterId(id);
    const cluster = data?.clusters.find(item => item.id === id);
    if (cluster) { setTitle(cluster.title); setKeyword(cluster.keyword); setPageId(data?.pages.find(page => page.url === cluster.url)?.id ?? ""); }
  }
  function choosePage(id: string) {
    setDiagnosis(null);
    setPageId(id);
    const page = data?.pages.find(item => item.id === id);
    if (page && !title.trim()) setTitle(page.title || page.url);
  }
  function useEvidence(evidence: DiagnosticEvidence, nextKind: TaskKind) {
    if (body.trim()) { setPendingEvidence({ evidence, kind: nextKind }); return; }
    bindEvidence(evidence, nextKind);
  }
  function bindEvidence(evidence: DiagnosticEvidence, nextKind: TaskKind) {
    setPendingEvidence(null);
    setDiagnosis(evidence); setKind(nextKind); setPageId(evidence.page?.id ?? ""); setClusterId(""); setBody("");
    setTitle((evidence.page?.title || evidence.selection.url || evidence.selection.query || "").slice(0, 250));
    setKeyword((evidence.selection.query ?? "").slice(0, 250));
    setNotice(t("Evidence added to the task below. Review your requirements before generating.", "依据已带入下方任务。请检查要求后再生成。"));
  }
  function applyEdit(edit: ParagraphEdit) {
    if (!editor || editor.jobId !== selectedJob?.id || selectedJob.kind !== "REWRITE_ARTICLE") return;
    const applied = applyParagraphEdit(editor.text, edit);
    if (!applied.ok) { setNotice(t("The source text has changed or is repeated. Review this passage manually.", "原文已变化或重复出现，请手动核对这段修改。")); return; }
    setEditor(current => current?.jobId === editor.jobId && current.text === editor.text ? { ...current, text: applied.text } : current);
    setNotice(t("Change applied to the local editor. Save the draft when ready.", "修改已采纳到本地编辑框，请保存草稿。"));
  }
  const savedPages = data?.pages ?? [];
  const pages = diagnosis?.page && !savedPages.some(page => page.id === diagnosis.page?.id) ? [...savedPages, { id: diagnosis.page.id, url: diagnosis.page.url, title: diagnosis.page.title, hasBody: diagnosis.page.body.length >= 100 }] : savedPages;
  const enoughBody = kind !== "REWRITE_ARTICLE" || hasRewriteBody(body, pageId, pages);
  const canGenerate = !!data && data.worker.online && execution.ready && !activeJob && !busy && !error && title.trim().length > 0 && enoughBody;
  const dateText = (date: string) => new Date(date).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return <div className={s.workbench}>
    <header className={s.header}>
      <div className={s.headingGroup}><span className={s.logo}><Bot size={27} /></span><div><p className={s.eyebrow}>CODEX WORKBENCH</p><h1>{t("Codex workbench", "Codex 工作台")}</h1></div></div>
      <div className={s.headerActions}><span className={s.domain}><Globe size={15} />{domain}</span><button type="button" className={s.iconButton} aria-label={t("Refresh workbench", "刷新工作台")} disabled={refreshing || !!busy} onClick={() => void refresh()}><RefreshCw size={18} className={refreshing ? s.spinning : ""} /></button></div>
    </header>
    <section className={s.intro}>
      <div><p className={s.kicker}>{t("From a useful idea to a usable draft", "从一个想法，到一份可用的草稿")}</p><h2>{t("Write. Improve. Make the next change clear.", "写好内容，让下一步修改更清楚。")}</h2><p>{t("Choose a task, add your context, and review the result here.", "选一个任务，补充要求，在这里检查并编辑生成结果。")}</p></div>
      <div className={s.connection}><div><span className={`${s.dot} ${data?.worker.online ? s.online : ""}`} />{loading ? t("Checking local helper", "正在检查本机助手") : data?.worker.online ? t("Local helper online", "本机助手在线") : t("Local helper offline", "本机助手未连接")}</div><strong>{t("Drafts for your review", "生成草稿，由你审阅")}</strong><span>{t("Choose your connection below.", "在下方选择新任务使用的连接。")}</span></div>
    </section>
    <div className={s.boundary}><ShieldCheck size={18} /><p>{t("Results stay as local drafts for your review. Publishing and website changes are not performed by these tasks.", "结果保存为本地草稿，供你审阅。这些任务不会发布文章或修改网站。")}</p></div>
    <EvidencePanel siteId={siteId} selection={previewSelection} pages={pages} disabled={!!busy || !!activeJob} onSelection={value => setPreviewSelection(value)} onUse={useEvidence} />
    {pendingEvidence && <div className={s.help} role="alert"><div><p>{t("Your task contains pasted source text. Switching to the selected page replaces that text and the task title. Copy it first if you want to keep it.", "任务中已有粘贴的原文。切换到所选页面将替换这份原文和任务标题，如需保留请先复制。")}</p><div className={s.actions}><button type="button" onClick={() => setPendingEvidence(null)}>{t("Keep current text", "保留当前原文")}</button><button type="button" disabled={!!busy || !!activeJob} onClick={() => bindEvidence(pendingEvidence.evidence, pendingEvidence.kind)}>{t("Use selected page instead", "改用所选页面原文")}</button></div></div></div>}
    <ChatGPTConnection siteId={siteId} disabled={!!busy || !!activeJob} onChange={setExecution} />
    <UsagePanel key={siteId} siteId={siteId} refreshKey={data?.jobs.map(job => `${job.id}:${job.status}:${job.updatedAt}`).join("|") ?? ""} />
    {error && <div className={s.error} role="alert"><span>{errorMessage(error)} {isAccountLimitError(error) && <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">{t("Manage usage", "管理用量")}</a>}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>{t("Refresh status", "刷新状态")}</button></div>}
    {notice && <p className={s.notice} role="status"><Check size={17} />{notice}</p>}
    {!loading && data && !data.worker.online && <div className={s.help}><CircleHelp size={18} /><div>{t("Start the local content helper, then refresh. If login expired, complete the dedicated ChatGPT login on this computer. Do not paste passwords or API keys here.", "请先启动本机内容助手，再刷新状态。登录过期时，在本机完成专用 ChatGPT 登录。不要在任务中填写密码或 API Key。")}</div></div>}
    <div className={s.workspace}>
      <form className={s.composer} onSubmit={generate}>
        <div className={s.sectionTitle}><span className={s.step}>01</span><div><h2>{t("Create a task", "新建任务")}</h2><p>{t("One click starts one new generation.", "每次点击生成，都会创建一个新任务。")}</p></div></div>
        {diagnosis && <div className={s.taskEvidenceBinding}><strong>{t("Saved evidence selected", "已选诊断依据")}</strong><span>{diagnosis.page?.url ?? diagnosis.selection.url}</span>{diagnosis.selection.query && <span>{diagnosis.selection.query}</span>}<p>{t("Evidence is checked again when you submit. A newer crawl requires a new preview.", "提交时会重新核对依据。有更新的抓取时，请刷新预览再带入。")}</p><button type="button" onClick={() => { setDiagnosis(null); setPageId(""); }}>{t("Clear selection", "取消带入")}</button></div>}
        <div className={s.taskChoices} role="group" aria-label={t("Task type", "任务类型")}>
          {tasks.map(task => <button key={task.kind} className={`${s.taskChoice} ${kind === task.kind ? s.selectedTask : ""}`} type="button" aria-pressed={kind === task.kind} onClick={() => setKind(task.kind)}><task.icon size={19} /><span><strong>{task.title}</strong><small>{task.description}</small></span>{kind === task.kind && <Check size={16} />}</button>)}
        </div>
        <label className={s.field}><span>{t("Topic or goal", "题目或修复目标")} <b>*</b></span><input required maxLength={250} value={title} onChange={event => setTitle(event.target.value)} placeholder={kind === "SEO_FIX_PLAN" ? t("e.g. Fix duplicate titles on product pages", "例如：修复产品页的重复标题") : t("e.g. A complete guide for first-time readers", "例如：面向新用户的完整使用指南")} /></label>
        <div className={s.fieldRow}><label className={s.field}><span>{t("Target keyword", "目标关键词")}</span><input maxLength={250} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder={t("Optional", "可选")} /></label><label className={s.field}><span>{t("Output language", "生成内容语言")}</span><select value={language} onChange={event => setLanguage(event.target.value as "zh-CN" | "en")}><option value="zh-CN">中文</option><option value="en">English</option></select></label></div>
        <label className={s.field}><span>{t("Requirements", "具体要求")}</span><textarea rows={4} maxLength={6000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder={t("Audience, tone, length, questions to answer, and facts to preserve…", "目标读者、语气、篇幅、需要回答的问题，以及必须保留的事实…")} /><small>{t("Interface language does not change your output language.", "切换界面语言不会改变这里选择的内容语言。")}</small></label>
        <details className={s.sources} open={kind === "REWRITE_ARTICLE"}>
          <summary><FileText size={16} />{t("Article and site context", "文章与站点资料")}</summary>
          <label className={s.field}><span>{t("Existing topic / brief", "已有选题或简报")}</span><select value={clusterId} onChange={event => chooseCluster(event.target.value)}><option value="">{t("None selected", "暂不选择")}</option>{data?.clusters.map(cluster => <option key={cluster.id} value={cluster.id}>{cluster.pillarTitle} · {cluster.title}</option>)}</select></label>
          <label className={s.field}><span>{t("Crawled page", "已抓取页面")}</span><select value={pageId} onChange={event => choosePage(event.target.value)}><option value="">{t("None selected", "暂不选择")}</option>{pages.map(page => <option key={page.id} value={page.id}>{page.title || page.url} · {page.hasBody ? t("Body available", "有正文") : t("Body needed", "需补充正文")}</option>)}</select></label>
          {pageId && <p className={s.sourceUrl}>{pages.find(page => page.id === pageId)?.url}</p>}
          <label className={s.field}><span>{t("Original text or supporting material", "原文或补充资料")}</span><textarea rows={7} maxLength={24000} value={body} onChange={event => setBody(event.target.value)} placeholder={t("Paste article text. Pasted text takes precedence over the stored crawl text.", "粘贴文章正文。填写后优先使用这份文字，而非抓取的旧正文。")} /><small>{body.length.toLocaleString()} / 24,000 {t("characters", "字符")}</small></label>
          <p className={s.sourceHint}>{t("This list is a sample: up to 150 pages from the latest completed crawl and 100 planned topics. If an article is missing, paste its text. Choosing a brief only adds its planning context; rewriting still needs page text.", "这里是样本：最多显示最近完成抓取的 150 个页面及 100 个选题。找不到文章时可粘贴原文。选题简报提供规划资料，改写仍需页面正文。")}</p>
          <p className={s.sourceHint}>{t("The task uses selected content and saved site evidence. It does not crawl a URL just because it appears in your request.", "任务使用选中的内容和本地已存站点证据。仅在要求里填写网址，不会自动抓取该网址。")}</p>
        </details>
        {!enoughBody && <p className={s.validation}>{t("For rewriting, select a page with saved body text or paste at least 100 characters.", "改写需要选择已有正文的页面，或粘贴至少 100 个字符的原文。")}</p>}
        <p className={s.privacy}>{execution.provider === "CHATGPT_APP" ? t("Submitting sends your requirements and selected article/site evidence to OpenAI using this app's authorized ChatGPT connection.", "提交后，将通过此应用已授权的 ChatGPT 连接，向 OpenAI 发送任务要求及所选文章、站点证据。") : t("Submitting sends your requirements and selected article/site evidence through the local Codex account to generate a response.", "提交后，将通过本机 Codex 账号发送任务要求及所选文章、站点证据以生成结果。")}</p>
        <button className={s.primaryButton} type="submit" disabled={!canGenerate}>{busy === "start" ? <Loader2 size={18} className={s.spinning} /> : <Sparkles size={18} />}{t("Generate with my account", "使用账号额度生成")}<ArrowRight size={17} /></button>
        {activeJob && <p className={s.sourceHint}>{t("This site has an active task. Wait for it to finish or cancel it first.", "当前站点已有任务正在处理，请等待完成或先取消。")} {activeJob.kind === "KEYWORD_RESEARCH" && <Link href={`/sites/${siteId}/keyword-research?mode=chatgpt`}>{t("View keyword task", "查看关键词任务")}</Link>} {activeJob.kind === "DOMAIN_ANALYSIS" && <Link href={`/sites/${siteId}/domain-overview?mode=chatgpt`}>{t("View domain diagnosis", "查看域名诊断")}</Link>} {activeJob.kind === "BACKLINK_ANALYSIS" && <Link href={`/sites/${siteId}/backlinks?mode=chatgpt`}>{t("View link analysis", "查看链接分析")}</Link>}</p>}
      </form>
      <section className={s.results}>
        <div className={s.sectionTitle}><span className={s.step}>02</span><div><h2>{t("Review and use", "审阅与使用")}</h2><p>{t("Your work is saved by site, as a draft.", "按站点保存任务，生成内容均为草稿。")}</p></div></div>
        <div className={s.history}><label htmlFor="workbench-history">{t("Task history · latest 20", "任务记录 · 最近 20 条")}</label><select id="workbench-history" value={selectedId ?? ""} onChange={event => chooseJob(event.target.value)}><option value="" disabled>{loading ? t("Loading…", "正在读取…") : t("Choose a task", "选择任务")}</option>{data?.jobs.map(job => <option key={job.id} value={job.id}>{statusName(job)} · {job.title}</option>)}</select></div>
        {switchTo && <div className={s.help} role="alert"><div><p>{t("This draft has unsaved changes. Save or copy them before switching tasks.", "当前草稿有未保存的修改，请先保存或复制。")}</p><div className={s.actions}><button type="button" onClick={() => setSwitchTo(null)}>{t("Keep editing", "继续编辑")}</button><button type="button" onClick={() => { setSelectedId(switchTo); setSwitchTo(null); }}>{t("Discard edits and switch", "放弃编辑并切换")}</button></div></div></div>}
        {!selectedJob ? <div className={s.empty}><span><FilePenLine size={38} /></span><h3>{t("Your next draft starts here", "下一份草稿，从这里开始")}</h3><p>{t("Choose a task on the left. Codex will return an article or a practical fix plan for you to review.", "选择左侧任务，Codex 会返回文章草稿或具体修复方案，供你检查和使用。")}</p><div className={s.emptyTags}><span>{t("Editable", "可编辑")}</span><span>Markdown</span><span>{t("Local history", "本地留存")}</span></div></div> : <>
          <div className={s.jobHeading}><div><span className={`${s.status} ${selectedJob.status === "SUCCEEDED" ? s.ready : ""}`}>{statusName(selectedJob)}</span><span className={s.kind}>{kindName(selectedJob.kind)}</span><h3>{selectedJob.title}</h3><p>{dateText(selectedJob.createdAt)} · {t("Not published", "尚未发布")}</p></div>{isActiveJob(selectedJob) && <button type="button" className={s.cancel} onClick={() => void cancel(selectedJob)} disabled={!!busy}><Square size={13} />{t("Cancel task", "取消任务")}</button>}</div>
          {isActiveJob(selectedJob) && <div className={s.progress} role="status"><Loader2 size={26} className={s.spinning} /><h3>{selectedJob.status === "QUEUED" ? t("Waiting for the local helper", "等待本机助手处理") : t("Codex is preparing your draft", "Codex 正在整理草稿")}</h3><p>{t("This page checks progress every five seconds. You can leave and return to this task later.", "页面每 5 秒检查进度。你可以稍后回来，在任务记录中查看结果。")}</p></div>}
          {selectedJob.error && <p className={s.jobError}>{errorMessage(selectedJob.error)} {isAccountLimitError(selectedJob.error) && <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">{t("Manage usage", "管理用量")}</a>}</p>}
          {selectedJob.diagnosis && <TaskEvidence evidence={selectedJob.diagnosis} />}
          {selectedJob.result && editor?.jobId === selectedJob.id && <>
            <p className={s.summary}>{selectedJob.result.summary}</p>
            {selectedJob.kind === "REWRITE_ARTICLE" && <ParagraphReview edits={selectedJob.result.paragraphEdits ?? []} text={editor.text} disabled={!!busy} onApply={applyEdit} />}
            <div className={s.editorBar}><span><FileText size={16} />{t("Draft text", "草稿正文")}<small>{dirty ? t("Unsaved changes", "有未保存的修改") : t("Saved locally", "已存本机")}</small></span><div className={s.actions}><button type="button" onClick={() => void copyDraft()}><Copy size={15} />{t("Copy", "复制")}</button><button type="button" onClick={downloadDraft}><Download size={15} />{t("Download .md", "下载 .md")}</button></div></div>
            <textarea className={s.editor} aria-label={t("Draft text", "草稿正文")} spellCheck={false} maxLength={60000} value={editor.text} onChange={event => setEditor(current => current ? { ...current, text: event.target.value } : current)} />
            <div className={s.editorFooter}><span>{editor.text.length.toLocaleString()} / 60,000 {t("characters", "字符")}</span><button type="button" disabled={!dirty || !!busy || !editor.text.trim()} onClick={() => void saveDraft()}><Save size={16} />{busy === "save" ? t("Saving…", "保存中…") : t("Save draft", "保存草稿")}</button></div>
            <details className={s.resultDetails}><summary>{t("SEO fields and review notes", "SEO 字段与审阅提示")}</summary><dl><dt>SEO Title</dt><dd>{selectedJob.result.metaTitle || t("Not provided", "未提供")}</dd><dt>Meta Description</dt><dd>{selectedJob.result.metaDescription || t("Not provided", "未提供")}</dd></dl>
              {selectedJob.result.changeNotes.length > 0 && <><h4>{t("Changes to review", "建议检查的修改")}</h4><ul>{selectedJob.result.changeNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></>}
              {selectedJob.result.factChecks.length > 0 && <><h4>{t("Facts to verify", "待核实信息")}</h4><ul>{selectedJob.result.factChecks.map((note, i) => <li key={i}>{note}</li>)}</ul></>}
              {selectedJob.result.internalLinks.length > 0 && <><h4>{t("Suggested internal links", "内链建议")}</h4><ul>{selectedJob.result.internalLinks.map((link, i) => <li key={i}><strong>{link.anchor}</strong><span className={s.sourceUrl}>{link.target}</span><p>{link.reason}</p></li>)}</ul></>}
              <p className={s.sourceHint}>{t("These are the original generation notes. Editing draft text does not regenerate these fields or change the original result.", "这里保留原始生成建议。编辑正文不会自动重写这些字段，也不会覆盖原始生成结果。")}</p>
            </details>
          </>}
        </>}
      </section>
    </div>
    <footer className={s.footer}><span><ShieldCheck size={16} />{t("Review facts and publish from your own website when ready.", "核实内容后，再到你的网站后台发布。")}</span><Link href={`/sites/${siteId}/content`}>{t("Back to content planning", "返回内容规划")}<ArrowRight size={14} /></Link></footer>
  </div>;
}
