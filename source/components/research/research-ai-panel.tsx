"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Copy, Download, Loader2, RefreshCw, Search, Sparkles, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { buttonVariants } from "@/components/ui/button";
import { ChatGPTConnection, type AccountExecution } from "@/components/ai-workbench/chatgpt-connection";
import { backlinkSampleShape, canGenerateResearch, researchFilename, researchReport, researchTaskPayload, type ResearchInput, type ResearchJob, type ResearchKind, type ResearchWorkspace } from "./research-ai-model";
import { appendResearchFocus, getResearchDefaults, ResearchMarketPresets, ResearchFocusPresets } from "./research-prompt-presets";
import s from "./keyword-ai-panel.module.css";
import r from "./research-ai-panel.module.css";

export function ResearchAiModes({ siteId, domain, kind, children }: { siteId: string; domain: string; kind: ResearchKind; children: ReactNode }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"sources" | "chatgpt">("sources");
  const [openedAi, setOpenedAi] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mode") === "chatgpt" || query.has("chatgpt")) { setMode("chatgpt"); setOpenedAi(true); }
  }, []);
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-3" role="group" aria-label={t("Research mode", "研究方式")}>
      <button type="button" aria-pressed={mode === "sources"} onClick={() => setMode("sources")} className={buttonVariants({ variant: mode === "sources" ? "default" : "outline" })}><Search size={16} />{t("Source data", "来源数据")}</button>
      <button type="button" aria-pressed={mode === "chatgpt"} onClick={() => { setMode("chatgpt"); setOpenedAi(true); }} className={buttonVariants({ variant: mode === "chatgpt" ? "default" : "outline" })}><Sparkles size={16} />{t("ChatGPT analysis", "ChatGPT 诊断建议")}</button>
    </div>
    <div hidden={mode !== "sources"}>{children}</div>
    {openedAi && <div hidden={mode !== "chatgpt"}><ResearchAiPanel key={`${siteId}:${kind}`} siteId={siteId} domain={domain} kind={kind} /></div>}
  </div>;
}

export function ResearchAiPanel({ siteId, domain, kind, initialData }: { siteId: string; domain: string; kind: ResearchKind; initialData?: ResearchWorkspace }) {
  const { t, locale } = useI18n();
  const backlinks = kind === "BACKLINK_ANALYSIS";
  const [data, setData] = useState<ResearchWorkspace | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [execution, setExecution] = useState<AccountExecution>({ provider: "CHATGPT_APP", ready: false });
  const [input, setInput] = useState<ResearchInput>(() => {
    const language = locale === "zh" ? "zh-CN" : "en";
    return { title: `${domain} ${backlinks ? t("link analysis", "链接诊断") : t("SEO analysis", "SEO 诊断")}`, language, body: "", ...getResearchDefaults(kind, language) };
  });
  const [selectedId, setSelectedId] = useState<string | null>(initialData?.jobs[0]?.id ?? null);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant`;
  const jobs = data?.jobs.filter(job => job.kind === kind) ?? [];
  const selected = jobs.find(job => job.id === selectedId);
  const report = researchReport(selected, kind);
  const evidence = selected?.researchEvidence;
  const active = data?.activeTask ?? data?.jobs.find(job => job.status === "QUEUED" || job.status === "RUNNING");
  const patch = (value: Partial<ResearchInput>) => setInput(current => ({ ...current, ...value }));
  function addFocus(prompt: string) {
    if (appendResearchFocus(input.instructions, prompt) === null) {
      setError(t("The added prompt would exceed 6,000 characters. Shorten your text first; your input is unchanged.", "追加后会超过 6,000 字符，请先缩短文字；现有输入已保留。"));
      return;
    }
    setInput(current => ({ ...current, instructions: appendResearchFocus(current.instructions, prompt) ?? current.instructions }));
  }
  const sampleError = backlinks ? backlinkSampleShape(input.body) : null;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current; setRefreshing(true);
    try {
      const response = await fetch(`${endpoint}?kind=${kind}`, { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok || result.site?.id !== siteId || !Array.isArray(result.jobs) || !result.worker) throw new Error("load_failed");
      if (signal?.aborted || sequence.current !== request) return false;
      setData(result); setSelectedId(current => current && result.jobs.some((job: ResearchJob) => job.id === current) ? current : result.jobs[0]?.id ?? null);
      setLoadError(""); setUncertain(false); return true;
    } catch {
      if (!signal?.aborted && sequence.current === request) setLoadError(t("Could not refresh tasks. Your input is preserved. Refresh before generating again.", "无法刷新任务记录，输入已保留。请刷新成功后再生成。"));
      return false;
    } finally { if (!signal?.aborted && sequence.current === request) { setLoading(false); setRefreshing(false); } }
  }, [endpoint, kind, siteId, t]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => { controller.abort(); sequence.current++; }; }, [refresh]);
  useEffect(() => {
    if (!active || loadError) return;
    const controller = new AbortController(); const timer = setTimeout(() => { void refresh(controller.signal); }, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, data, loadError, refresh]);
  const canGenerate = canGenerateResearch(kind, input, execution, { online: !!data?.worker.online, active: !!active, busy, loading: loading || refreshing || !!loadError, uncertain });
  function readableError(message: string) {
    const sampleRow = /Invalid backlink sample row (\d+)/i.exec(message);
    if (sampleRow) return t(`Check backlink sample row ${sampleRow[1]}: use an external public HTTP(S) source URL, a target on this site's exact origin, and an optional anchor, separated by tabs. Do not include a header.`, `请检查反链样本第 ${sampleRow[1]} 行：来源需为其他公开网站的 HTTP(S) URL，目标需为本站同源 URL，可附锚文本；以制表符分隔，不含表头。`);
    if (/Research evidence is too large/i.test(message)) return t("The evidence sample is too large. Reduce the pasted backlink rows and try again.", "证据样本过大，请减少粘贴的反链行数后重试。");
    if (/usage.limit|quota|rate.limit|not_eligible/i.test(message)) return t("This account cannot generate now. Check its plan eligibility and usage in ChatGPT, then start a new task when available.", "此账号暂时无法生成。请在 ChatGPT 检查套餐资格及用量，恢复后再手动新建任务。");
    if (/Canceled by user/i.test(message)) return t("Canceled. Allowance already used is not refunded.", "已取消，已使用的账号额度不会退回。");
    if (/worker|codex_executable_missing/i.test(message)) return t("The local content helper is unavailable. Start the local software and refresh tasks.", "本机内容助手暂不可用，请启动本地软件后刷新任务记录。");
    if (/chatgpt|connection|profile|model|plan permission|credit overage/i.test(message)) return t("Check the ChatGPT connection, model and plan permission above before starting another task.", "请检查上方 ChatGPT 连接、模型与套餐授权，再手动新建任务。");
    if (/already has an active/i.test(message)) return t("This site has an active task. Refresh its status and wait for it to finish.", "此站点已有进行中的任务，请刷新状态并等待完成。");
    if (/timed out|timeout/i.test(message)) return t("The task timed out. Check its saved state before generating again. No automatic retry was sent.", "任务超时，请检查已保存任务后再生成。系统没有自动重试。");
    return message;
  }
  async function generate(event: FormEvent) {
    event.preventDefault(); if (!canGenerate || mutating.current) return;
    mutating.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(researchTaskPayload(kind, input, execution)) });
      const result = await response.json();
      if (!response.ok) { setError(readableError(result.error || t("Could not create the task.", "未能创建任务。"))); return; }
      if (typeof result.jobId !== "string") throw new Error("invalid_response");
      setSelectedId(result.jobId); setNotice(t("Task submitted. The report is saved for review; no changes are applied to your website.", "任务已提交。报告保存后供你核对，不会应用到网站。")); await refresh();
    } catch {
      setUncertain(true); setError(t("The response was interrupted and a task may already exist. Refresh task history before submitting again. No automatic retry was sent.", "响应中断，任务可能已经创建。请先刷新任务记录再决定是否提交，系统没有自动重试。"));
    } finally { mutating.current = false; setBusy(false); }
  }
  async function cancel() {
    if (!selected || busy || mutating.current) return;
    mutating.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", jobId: selected.id }) });
      if (!response.ok) throw new Error();
      setNotice(t("Canceled. Allowance already used is not refunded.", "已取消任务，已使用的账号额度不会退回。")); await refresh();
    } catch { setError(t("Cancellation could not be confirmed. Refresh tasks to check the state.", "未能确认取消结果，请刷新任务记录查看状态。")); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function copy() {
    if (!report) return;
    try { await navigator.clipboard.writeText(report.contentMarkdown); setNotice(t("Report copied.", "已复制报告。")); }
    catch { setError(t("Clipboard access failed. Select the report text and copy it manually.", "无法访问剪贴板，请在报告框内全选并复制。")); }
  }
  function download() {
    if (!selected || !report) return;
    const url = URL.createObjectURL(new Blob([report.contentMarkdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = researchFilename(selected.title); anchor.click(); URL.revokeObjectURL(url);
  }
  const status = (job: ResearchJob) => ({ QUEUED: t("Queued", "排队中"), RUNNING: t("Analyzing", "诊断中"), SUCCEEDED: t("Report ready", "报告就绪"), FAILED: job.error?.startsWith("Canceled by user") ? t("Canceled", "已取消") : t("Failed", "未完成") })[job.status];
  return <section className={s.panel} aria-label={backlinks ? t("ChatGPT link analysis", "ChatGPT 链接诊断") : t("ChatGPT domain analysis", "ChatGPT 域名诊断")}>
    <header className={s.intro}><div><div className={s.kicker}><Sparkles size={16} />CHATGPT · {backlinks ? "LINK REVIEW" : "SITE REVIEW"}</div><h2>{backlinks ? t("Understand links before taking action", "先看清链接证据，再决定下一步") : t("Turn saved site evidence into a plan", "把站点证据，变成可核对的优化方案")}</h2><p>{backlinks ? t("Analyze saved outgoing links and any backlink sample you paste. ChatGPT does not provide a backlink database, verify links or infer your site's total backlinks.", "分析已抓取的出站链接及你粘贴的反链样本。ChatGPT 不提供反链数据库，不核验链接，也不推测网站反链总量。") : t("Use your ChatGPT plan to interpret saved GSC and crawl samples, identify uncertainties and suggest priorities. This is evidence-based advice, not a live competitor database or a ranking forecast.", "使用 ChatGPT 套餐解读本地 GSC 与抓取样本，列出待核查问题和优化优先级。这是基于证据的建议，不是实时竞品数据库或排名预测。")}</p></div><Link href={`/sites/${siteId}/assistant`}>{t("Workbench and usage →", "工作台与用量统计 →")}</Link></header>
    <details className={s.connection} open><summary>{t("ChatGPT connection and model", "ChatGPT 账号连接与模型")}</summary><ChatGPTConnection siteId={siteId} disabled={busy || !!active} onChange={setExecution} returnPage={backlinks ? "backlinks" : "domain-overview"} appOnly /></details>
    {(error || loadError) && <p className={s.error} role="alert">{error || loadError}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}
    <div className={s.layout}>
      <form className={s.card} onSubmit={generate}><h3>{t("1. Define this analysis", "1. 设置本次诊断")}</h3><p className={s.muted}>{t("Each click creates a new task and uses your shared ChatGPT allowance.", "每次点击生成都会新建任务，使用你共享的 ChatGPT 套餐额度。")}</p>
        <fieldset className={s.fields} disabled={busy}>
          <label className={s.field}>{t("Report title", "报告题目")}<input required maxLength={250} value={input.title} onChange={e => patch({ title: e.target.value })} /></label>
          <label className={s.field}>{t("Target market and audience", "目标市场与读者")}<input required maxLength={120} placeholder={t("e.g. Beginners in the United States", "例如：中国大陆，首次使用 iPhone 的用户")} value={input.targetMarket} onChange={e => patch({ targetMarket: e.target.value })} /></label>
          <ResearchMarketPresets language={input.language} onSelect={targetMarket => patch({ targetMarket })} disabled={busy} />
          <p className={s.muted}>{t("This guides recommendations only. It does not filter or change the saved GSC period, country or language scope.", "仅用于指导建议，不筛选或改变已保存 GSC 的日期、国家和语言范围。")}</p>
          <label className={s.field}>{t("Report language", "报告语言")}<select value={input.language} onChange={e => patch({ language: e.target.value as ResearchInput["language"] })}><option value="zh-CN">{t("Simplified Chinese", "简体中文")}</option><option value="en">{t("English", "英语")}</option></select></label>
          <label className={s.field}>{t("Questions to focus on (optional)", "重点问题（选填）")}<textarea maxLength={6000} value={input.instructions} onChange={e => patch({ instructions: e.target.value })} placeholder={backlinks ? t("Which links or anchor texts need a manual review?", "哪些链接或锚文本需要人工复核？") : t("Which saved observations should I act on first?", "根据已有证据，哪些问题应该先处理？")} /></label>
          <ResearchFocusPresets kind={kind} language={input.language} onSelect={addFocus} disabled={busy} />
          {backlinks && <><label className={s.field}>{t("Paste backlink samples (optional, TSV)", "粘贴反向链接样本（选填，TSV）")}<textarea className={r.sample} maxLength={24000} value={input.body} onChange={e => patch({ body: e.target.value })} placeholder={t("Source URL [TAB] target URL on your site [TAB] anchor text (optional)", "来源 URL [制表符] 本站目标 URL [制表符] 锚文本（可省略）")} /></label><p className={s.muted}>{t("No header. Up to 50 rows and 24,000 characters. Copy 2 or 3 columns from a spreadsheet. Use full HTTP(S) URLs: source on another public site, target on this site. All pasted links remain unverified; no URLs are fetched. Leave blank to review outgoing links only.", "不含表头，最多 50 行、24,000 字符，可从表格复制 2 或 3 列。使用完整 HTTP(S) URL：来源在其他公开网站，目标在本站。粘贴链接全部标记为未核验，不会访问网址；留空则只诊断已抓取的出站链接。")}</p><p className={s.muted}>{input.body.length.toLocaleString()} / 24,000</p>{sampleError && <p className={s.error} role="alert">{t("Check the sample: at most 50 nonempty rows, 24,000 characters, and 2 or 3 TAB-separated columns per row.", "请检查样本：最多 50 个非空行、24,000 字符，每行 2 或 3 列，以制表符分隔。")}</p>}</>}
        </fieldset>
        <p className={`${s.notice} mt-5`}>{t("Submission sends your request and bounded saved site evidence to OpenAI through this ChatGPT connection. Any pasted samples are included. No website changes, automatic crawls or paid data queries are made.", "提交后，将通过此 ChatGPT 连接向 OpenAI 发送需求及本地站点证据样本，包括你粘贴的资料。不修改网站，不自动抓取，也不发起付费数据查询。")}</p>
        {active && <p className={s.muted}>{t("This site already has an active task. Wait for it to finish or cancel it in its task history.", "此站点已有进行中的任务，请等待完成或在对应任务记录中取消。")}</p>}
        {!loading && !data?.worker.online && <p className={s.error}>{t("Local content helper is offline. Start the local software, then refresh tasks.", "本机内容助手离线，请启动本地软件后刷新任务记录。")}</p>}
        <button type="submit" className={s.submit} disabled={!canGenerate}>{busy ? <Loader2 size={17} className={s.spinner} /> : <Sparkles size={17} />}{t("Analyze with ChatGPT plan", "使用 ChatGPT 账号额度诊断")}</button>
        {!execution.ready && <p className={`${s.muted} mt-3`}>{t("Connect an account, choose a model and confirm credit overage is disabled above.", "请在上方连接账号、选择模型，并确认已关闭超额额度使用。")}</p>}
      </form>
      <aside className={s.card}><div className={s.header}><h3>{t("2. Review reports", "2. 查看诊断报告")}</h3><button type="button" className={s.secondary} aria-label={t("Refresh research tasks", "刷新诊断任务")} disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? s.spinner : ""} /></button></div><p className={s.muted}>{t("Latest 20 tasks of this type for this site. Failed tasks are never retried automatically.", "本网站最近 20 条同类诊断任务，失败不会自动重试。")}</p>
        <label className={`${s.field} mt-5`}>{t("Saved task", "已保存的任务")}<select value={selectedId ?? ""} disabled={!jobs.length} onChange={e => setSelectedId(e.target.value)}><option value="" disabled>{loading ? t("Loading…", "正在读取…") : t("No reports yet", "尚无诊断报告")}</option>{jobs.map(job => <option key={job.id} value={job.id}>{status(job)} · {job.title}</option>)}</select></label>
        {selected ? <><p className={s.status}>{["RUNNING", "QUEUED"].includes(selected.status) && <Loader2 size={15} className={s.spinner} />}{status(selected)}</p><p className={s.muted}>{new Date(selected.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</p>{selected.error && <p role="alert" className={`${s.error} mt-4`}>{readableError(selected.error)}</p>}{["QUEUED", "RUNNING"].includes(selected.status) && <button type="button" className={`${s.secondary} mt-4`} disabled={busy} onClick={() => void cancel()}><Square size={13} />{t("Cancel task", "取消任务")}</button>}</> : <p className={`${s.muted} mt-6`}>{t("Reports distinguish observed facts, suggestions and missing evidence. Verify recommendations before using them.", "报告会区分已观察事实、推断建议与缺失依据，使用前请核对。")}</p>}
        <p className={`${s.notice} mt-6`}>{backlinks ? t("A crawl's outgoing links are not incoming backlinks. Pasted samples are not a complete backlink profile. Total backlinks and authority scores stay unknown.", "抓取的出站链接不是反向链接。粘贴样本不代表完整反链概况，反链总量与权威评分保持未知。") : t("GSC clicks are observed clicks for a saved period, not estimated market traffic. Missing coverage, competitor rankings and traffic potential remain unknown.", "GSC 点击量是已保存时段内的点击记录，不是估算市场流量。缺失覆盖、竞品排名和流量潜力保持未知。")}</p>
      </aside>
    </div>
    {report && <section className={`${s.card} ${r.report}`} aria-label={t("Analysis report", "诊断报告")}><div className={s.resultHeader}><div><h3>{selected?.title}</h3><p className={s.muted}>{report.summary}</p></div><div className={r.actions}><button className={s.secondary} type="button" onClick={() => void copy()}><Copy size={15} />{t("Copy report", "复制报告")}</button><button className={s.secondary} type="button" onClick={download}><Download size={15} />{t("Download Markdown", "下载 Markdown")}</button></div></div><label className={s.field}>{t("Report text for review", "待核对的报告正文")}<textarea readOnly value={report.contentMarkdown} /></label><details className={s.checks}><summary>{t("Proposed actions and checks", "建议行动与核查事项")}</summary><ul>{[...report.changeNotes, ...report.factChecks].map((text, i) => <li key={i}>{text}</li>)}</ul></details></section>}
    {evidence && <details className={`${s.card} ${r.evidence}`}><summary>{t("Saved evidence used by this task", "本次任务使用的已保存证据")}</summary><dl><div><dt>{t("Crawl date", "抓取日期")}</dt><dd>{evidence.sources.crawl?.finishedAt ?? t("Unknown", "未知")}</dd></div><div><dt>{t("GSC period", "GSC 时段")}</dt><dd>{evidence.sources.gsc ? `${evidence.sources.gsc.period.start} ~ ${evidence.sources.gsc.period.end}` : t("Unknown", "未知")}</dd></div><div><dt>{t("Page samples", "页面样本")}</dt><dd>{evidence.counters.sampledPages}</dd></div><div><dt>{t("Outgoing link samples", "出站链接样本")}</dt><dd>{evidence.counters.sampledOutgoingLinks}</dd></div><div><dt>{t("Pasted backlink samples (unverified)", "粘贴反链样本（未核验）")}</dt><dd>{evidence.sources.pastedBacklinks.count}</dd></div><div><dt>{t("Total backlinks", "反链总量")}</dt><dd>{t("Unknown", "未知")}</dd></div></dl><p className={s.muted}>{t("The following shows up to 12 sampled pages and 12 sampled links. Missing from a sample does not mean missing from the site.", "以下最多显示 12 个页面样本及 12 条链接样本。样本中没有，不代表网站不存在。")}</p><ul>{evidence.pages.slice(0, 12).map(page => <li key={page.id}><code>{page.id} · {page.url}</code></li>)}{evidence.links.slice(0, 12).map(link => <li key={link.id}><code>{link.id} · {link.direction === "OUTGOING" ? t("Outgoing", "出站") : t("Unverified incoming sample", "未核验入站样本")} · {link.sourceUrl} → {link.targetUrl}</code></li>)}</ul><ul>{evidence.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}
  </section>;
}
