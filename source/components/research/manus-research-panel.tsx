"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Download, ExternalLink, Loader2, RefreshCw, Telescope } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { ResearchTask, ResearchTaskList } from "@/lib/manus/research";
import type { ManusTaskStatus } from "@/lib/manus/tasks";
import type { GeoSourceRow, GeoSourcesInput, Level, LinkProspectRow, LinkProspectsInput, ManusTemplate } from "@/lib/manus/templates";

const settingsLink = "/settings?connect=manus#connection-manus";
const fieldClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const MAX_SOURCES = 10;
const MAX_COMPETITORS = 5;

// randomUUID needs HTTPS. LAN deployments can also generate a v4 UUID with getRandomValues.
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function statusText(status: ManusTaskStatus, t: Translator) {
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
    case "missing_key": case "unreadable_key": case "unauthorized": return t("Check or replace your Manus API key in Settings.", "请到设置中检查或替换 Manus API 密钥。");
    case "insufficient_credits": return t("Check the credit balance in your Manus account.", "请检查 Manus 账号的积分余额。");
    case "rate_limited": return t("Manus has reached its request limit. Try again later.", "已达到 Manus 请求频率上限，请稍后再试。");
    case "geo_not_set_up": return t("Set up prompt tracking on this page and run it once: the sources come from its answers.", "请先在本页设置提示词跟踪并运行一次：来源取自它的回答。");
    case "no_sources": return t("Choose at least one source.", "请至少选择一个来源。");
    case "invalid_input": return t("Check the fields: a topic of 3 to 200 characters, competitor domains such as example.com, and an output language.", "请检查输入：主题 3 至 200 个字符，竞品填写域名（如 example.com），并填写输出语言。");
    case "no_structured_result": return t("Manus finished but returned no usable table. Open the task in Manus to read its answer.", "Manus 已完成，但没有返回可用的表格。请打开 Manus 任务查看回答。");
    case "workspace_maintenance": return t("Manus tasks are paused on this workspace.", "此工作区暂停了 Manus 任务。");
    case "submission": return t("The submission could not be confirmed. Refresh the list and check Manus before submitting again.", "暂时无法确认是否已提交。再次提交前，请刷新列表并核对 Manus 账号中的任务。");
    case "history": return t("Could not load saved tasks. Refresh the list to try again.", "未能加载已保存任务，请刷新列表重试。");
    case "session": case "sign_in_required": return t("Sign in again to access this site.", "请重新登录以访问此站点。");
    default: return t("Manus could not complete the request. Check the saved task and your Manus account.", "Manus 未能完成请求，请检查已保存的任务与 Manus 账号。");
  }
}

function levelText(value: Level | null, t: Translator) {
  return value === "high" ? t("High", "高") : value === "medium" ? t("Medium", "中") : value === "low" ? t("Low", "低") : "-";
}

function sourceTypeText(type: string, t: Translator) {
  const names: Record<string, string> = {
    REVIEW: t("Reviews and lists", "评测与榜单"), FORUM: t("Forum or Q&A", "论坛与问答"), VIDEO: t("Video", "视频"), ENCYCLOPEDIA: t("Encyclopedia", "百科"),
    NEWS: t("News and media", "新闻媒体"), BLOG: t("Blog platform", "博客平台"), SOCIAL: t("Social", "社交平台"), GOV_EDU: t("Government or education", "政府与教育"),
    ranking_list: t("Ranking or list", "排行榜单"), review_site: t("Review site", "评测网站"), forum_or_qa: t("Forum or Q&A", "论坛与问答"), directory: t("Directory", "目录"),
    news_or_media: t("News and media", "新闻媒体"), encyclopedia: t("Encyclopedia", "百科"), video: t("Video", "视频"), blog: t("Blog", "博客"),
    resource_page: t("Resource page", "资源页"), list_or_roundup: t("List or roundup", "榜单或汇总"), association: t("Association", "行业协会"),
    guest_post: t("Contributed articles", "接受投稿"), unlinked_mention: t("Mention without a link", "提及未加链接"), competitor_link: t("Links to competitors", "链接了竞品"),
    community: t("Community", "社区"),
  };
  return names[type] ?? t("Other", "其他");
}

function safeLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function ExternalAnchor({ href, children }: { href: string | null; children: React.ReactNode }) {
  const link = safeLink(href);
  return link ? <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 break-all text-link">{children}<ExternalLink className="size-3 shrink-0" aria-hidden /></a> : <>{children}</>;
}

function csvOf(kind: ManusTemplate, task: ResearchTask): string {
  const cell = (value: string | null) => `"${(value ?? "").replace(/"/g, '""')}"`;
  const lines = kind === "GEO_SOURCES"
    ? [["domain", "page_type", "maintainer", "how_to_get_included", "requirements", "contact_url", "effort", "priority", "why", "evidence_urls", "observed_on"],
      ...(task.rows as GeoSourceRow[]).map(r => [r.domain, r.pageType, r.maintainer, r.howToGetIncluded, r.requirements, r.contactUrl, r.effort, r.priority, r.why, r.evidenceUrls.join(" "), r.observedOn])]
    : [["url", "domain", "prospect_type", "relevance", "approach", "contact_url", "pitch_angle", "effort", "priority", "evidence_urls", "observed_on"],
      ...(task.rows as LinkProspectRow[]).map(r => [r.url, r.domain, r.prospectType, r.relevance, r.approach, r.contactUrl, r.pitchAngle, r.effort, r.priority, r.evidenceUrls.join(" "), r.observedOn])];
  return "﻿" + lines.map(line => line.map(v => cell(v)).join(",")).join("\r\n");
}

function downloadCsv(kind: ManusTemplate, task: ResearchTask) {
  const url = URL.createObjectURL(new Blob([csvOf(kind, task)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${kind === "GEO_SOURCES" ? "geo-sources" : "link-prospects"}-${task.createdAt.slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Rows({ kind, task, t }: { kind: ManusTemplate; task: ResearchTask; t: Translator }) {
  if (!task.rows.length) return null;
  if (kind === "GEO_SOURCES") {
    return <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
      <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
        <th className="py-2 pr-3 font-normal">{t("Source", "来源")}</th>
        <th className="py-2 pr-3 font-normal">{t("How to get on it", "怎么进入")}</th>
        <th className="py-2 pr-3 font-normal">{t("Way in", "联系或投稿入口")}</th>
        <th className="py-2 pr-3 font-normal">{t("Effort", "难度")}</th>
        <th className="py-2 font-normal">{t("Priority", "优先级")}</th>
      </tr></thead>
      <tbody>{(task.rows as GeoSourceRow[]).map(r => <tr key={r.domain} className="border-b border-border-soft align-top">
        <td className="py-2 pr-3"><span className="font-medium text-text-strong">{r.domain}</span>
          <span className="block text-xs text-muted-foreground">{sourceTypeText(r.pageType, t)}{r.maintainer ? ` · ${r.maintainer}` : ""}</span></td>
        <td className="py-2 pr-3"><p className="whitespace-pre-wrap break-words">{r.howToGetIncluded}</p>
          {r.requirements && <p className="mt-1 text-xs text-muted-foreground">{t("Needs: {text}", "需要：{text}", { text: r.requirements })}</p>}
          {r.why && <p className="mt-1 text-xs text-muted-foreground">{r.why}</p>}
          {r.evidenceUrls.length > 0 && <p className="mt-1 flex flex-wrap gap-x-3 text-xs">{r.evidenceUrls.map((u, i) => <ExternalAnchor key={u} href={u}>{t("Evidence {n}", "依据 {n}", { n: i + 1 })}</ExternalAnchor>)}</p>}</td>
        <td className="py-2 pr-3 text-xs">{r.contactUrl ? <ExternalAnchor href={r.contactUrl}>{r.contactUrl.replace(/^https?:\/\//, "").slice(0, 48)}</ExternalAnchor> : "-"}</td>
        <td className="py-2 pr-3 text-xs">{levelText(r.effort, t)}</td>
        <td className="py-2 text-xs">{levelText(r.priority, t)}</td>
      </tr>)}</tbody>
    </table></div>;
  }
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
    <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
      <th className="py-2 pr-3 font-normal">{t("Page", "页面")}</th>
      <th className="py-2 pr-3 font-normal">{t("Why it fits", "为什么合适")}</th>
      <th className="py-2 pr-3 font-normal">{t("Approach and angle", "联系方式与切入角度")}</th>
      <th className="py-2 pr-3 font-normal">{t("Effort", "难度")}</th>
      <th className="py-2 font-normal">{t("Priority", "优先级")}</th>
    </tr></thead>
    <tbody>{(task.rows as LinkProspectRow[]).map(r => <tr key={r.url} className="border-b border-border-soft align-top">
      <td className="py-2 pr-3"><ExternalAnchor href={r.url}><span className="font-medium">{r.domain}</span></ExternalAnchor>
        <span className="block text-xs text-muted-foreground">{sourceTypeText(r.prospectType, t)}</span></td>
      <td className="py-2 pr-3"><p className="whitespace-pre-wrap break-words">{r.relevance}</p>
        {r.evidenceUrls.length > 0 && <p className="mt-1 flex flex-wrap gap-x-3 text-xs">{r.evidenceUrls.map((u, i) => <ExternalAnchor key={u} href={u}>{t("Evidence {n}", "依据 {n}", { n: i + 1 })}</ExternalAnchor>)}</p>}</td>
      <td className="py-2 pr-3"><p className="whitespace-pre-wrap break-words">{r.approach}</p>
        {r.pitchAngle && <p className="mt-1 text-xs text-muted-foreground">{t("Angle: {text}", "角度：{text}", { text: r.pitchAngle })}</p>}
        {r.contactUrl && <p className="mt-1 text-xs"><ExternalAnchor href={r.contactUrl}>{t("Contact or submission page", "联系或投稿页面")}</ExternalAnchor></p>}</td>
      <td className="py-2 pr-3 text-xs">{levelText(r.effort, t)}</td>
      <td className="py-2 text-xs">{levelText(r.priority, t)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function taskTitle(kind: ManusTemplate, task: ResearchTask): string {
  return kind === "GEO_SOURCES"
    ? (task.input as GeoSourcesInput).sources.map(s => s.domain).join(" · ")
    : (task.input as LinkProspectsInput).topic;
}

/** `initial`: a task list already read (the panel still refreshes it on mount). */
export function ManusResearchPanel({ siteId, kind, initial }: { siteId: string; kind: ManusTemplate; initial?: ResearchTaskList }) {
  const { t, locale } = useI18n();
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/manus-research`;
  const [history, setHistory] = useState<ResearchTaskList | null>(initial ?? null);
  const [selected, setSelected] = useState<string[]>(() => initial?.options.gaps.slice(0, 5).map(g => g.domain) ?? []);
  const [topic, setTopic] = useState("");
  const [competitors, setCompetitors] = useState(initial?.options.competitorDomains.join("\n") ?? "");
  const [audience, setAudience] = useState(initial?.options.market ?? "");
  const [language, setLanguage] = useState(locale === "zh" ? "简体中文" : "English");
  const [profile, setProfile] = useState<"lite" | "standard">("lite");
  const [confirmed, setConfirmed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(initial?.tasks[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>("list");
  const [error, setError] = useState("");
  const actionLock = useRef(false);
  const lastAttempt = useRef<{ id: string; payload: string } | null>(null);
  const prefilled = useRef(!!initial);

  // Reads the list; sets state only after the response, so the first load can start from an effect.
  const fetchList = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    try {
      const url = `${endpoint}?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(url, { cache: "no-store", signal });
      if (!res.ok) throw new Error(res.status === 401 ? "session" : "history");
      const list = await res.json() as ResearchTaskList;
      if (!Array.isArray(list.tasks) || typeof list.connected !== "boolean") throw new Error("history");
      if (signal?.aborted) return;
      setHistory(previous => cursor && previous
        ? { ...previous, nextCursor: list.nextCursor, tasks: [...previous.tasks, ...list.tasks.filter(task => !previous.tasks.some(saved => saved.id === task.id))] }
        : list);
      if (!cursor) {
        setExpandedId(id => list.tasks.some(task => task.id === id) ? id : list.tasks[0]?.id ?? null);
        if (!prefilled.current) {
          prefilled.current = true;
          setSelected(list.options.gaps.slice(0, 5).map(g => g.domain));
          setCompetitors(list.options.competitorDomains.join("\n"));
          setAudience(list.options.market);
        }
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error && cause.message === "session" ? "session" : "history");
    } finally {
      if (!signal?.aborted) { actionLock.current = false; setBusy(null); }
    }
  }, [endpoint, kind]);

  useEffect(() => {
    const controller = new AbortController();
    actionLock.current = true;
    void fetchList(undefined, controller.signal);
    return () => { controller.abort(); actionLock.current = false; };
  }, [fetchList]);

  function load(cursor?: string) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy("list");
    setError("");
    void fetchList(cursor);
  }

  const options = history?.options;
  const competitorList = competitors.split(/[\s,，]+/).map(c => c.trim()).filter(Boolean);
  const fieldsReady = kind === "GEO_SOURCES"
    ? selected.length > 0 && selected.length <= MAX_SOURCES && !!options?.brand
    : topic.trim().length >= 3 && topic.trim().length <= 200 && competitorList.length <= MAX_COMPETITORS;
  const ready = !!history?.connected && !busy && fieldsReady && !!language.trim() && confirmed;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || actionLock.current) return;
    actionLock.current = true;
    setBusy("create");
    setError("");
    setConfirmed(false);
    try {
      const input = kind === "GEO_SOURCES"
        ? { kind, domains: selected, language: language.trim(), profile }
        : { kind, topic: topic.trim(), competitors: competitorList, audience: audience.trim(), language: language.trim(), profile };
      const payload = JSON.stringify(input);
      // A lost response must not turn a manual retry into a second paid task.
      if (lastAttempt.current?.payload !== payload) lastAttempt.current = { id: newRequestId(), payload };
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true, requestId: lastAttempt.current.id }),
      });
      const data = await res.json();
      if (!res.ok && !data.task) { setError(data.error || "submission"); return; }
      if (!data.task?.id) throw new Error("submission");
      const task = data.task as ResearchTask;
      setHistory(previous => previous && ({ ...previous, tasks: [task, ...previous.tasks.filter(item => item.id !== task.id)] }));
      setExpandedId(task.id);
      lastAttempt.current = null;
    } catch {
      setError("submission");
    } finally { actionLock.current = false; setBusy(null); }
  }

  async function update(id: string) {
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

  const geo = kind === "GEO_SOURCES";
  const toggle = (domain: string, on: boolean) => {
    setConfirmed(false);
    setSelected(current => on ? (current.length >= MAX_SOURCES ? current : [...current, domain]) : current.filter(d => d !== domain));
  };

  return <section className="panel space-y-5 p-5 sm:p-6" aria-busy={!!busy}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-text-strong">{geo ? t("Break down AI citation sources with Manus", "让 Manus 拆解 AI 引用来源") : t("Research link prospects with Manus", "让 Manus 调研外链机会")}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{geo
          ? t("Pick sites that AI answers cite while naming competitors and leaving you out. Manus reads each one and returns what kind of page it is, who runs it, how a brand gets on it and where to ask. Prompt tracking keeps measuring; this finds the way in.", "从 AI 回答引用、却只提到竞品没提到你的网站里挑几个，让 Manus 逐个查看：是什么页面、谁在维护、品牌怎样才能被收录、去哪里申请。提示词跟踪继续负责测量，这里负责找到进入的路径。")
          : t("Give a topic and a few competitors. Manus looks for resource pages, lists, directories and associations, publications that take contributed articles and pages that link to competitors, each with a way to ask and an angle for the pitch. It only researches: it contacts no one.", "给定主题和几个竞品，让 Manus 找资源页、榜单、行业目录和协会、接受投稿的媒体，以及链接了竞品的页面，每条都附上联系途径和切入角度。Manus 只做调研，不会联系任何人。")}</p>
      </div>
      <Link href={settingsLink} className="text-sm text-link">{history?.connected ? t("Manage Manus API key", "管理 Manus API 密钥") : t("Connect Manus in Settings", "在设置中连接 Manus")}</Link>
    </div>

    <form onSubmit={submit} className="space-y-4">
      {geo ? (!options ? null : !options.brand
        ? <p className="text-sm text-muted-foreground">{t("Set up prompt tracking above and run it once: the sources come from its answers.", "请先在上方设置提示词跟踪并运行一次：来源取自它的回答。")}</p>
        : options.gaps.length === 0
          ? <p className="text-sm text-muted-foreground">{t("No citation gap in the latest answers: no cited site named a competitor while leaving {brand} out.", "最近的回答里没有引用缺口：没有哪个被引用的网站只提到竞品而没提到 {brand}。", { brand: options.brand })}</p>
          : <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Sources to research (up to {n})", "要调研的来源（最多 {n} 个）", { n: MAX_SOURCES })}</legend>
            <div className="grid gap-2 md:grid-cols-2">{options.gaps.map(g => <label key={g.domain} className="flex items-start gap-2 rounded-md border border-border-soft px-3 py-2 text-sm">
              <input type="checkbox" className="mt-1" checked={selected.includes(g.domain)} disabled={busy === "create"} onChange={e => toggle(g.domain, e.target.checked)} />
              <span className="min-w-0"><span className="font-medium text-text-strong">{g.domain}</span>
                <span className="block text-xs text-muted-foreground">{sourceTypeText(g.type, t)} · {t("{gap} of {all} answers left you out", "{all} 个回答中 {gap} 个没提到你", { gap: g.gapAnswers, all: g.answers })}{g.competitors.length ? ` · ${g.competitors.slice(0, 3).join(", ")}` : ""}</span></span>
            </label>)}</div>
          </fieldset>)
        : <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium md:col-span-2">{t("Topic", "主题")}
            <input className={fieldClass} maxLength={200} value={topic} disabled={busy === "create"} placeholder={t("e.g. modular sofas for small apartments", "例如：小户型模块化沙发")} onChange={e => { setTopic(e.target.value); setConfirmed(false); }} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">{t("Competitor domains (up to {n})", "竞品域名（最多 {n} 个）", { n: MAX_COMPETITORS })}
            <textarea rows={3} className={fieldClass} value={competitors} disabled={busy === "create"} placeholder="example.com" onChange={e => { setCompetitors(e.target.value); setConfirmed(false); }} />
            {competitorList.length > MAX_COMPETITORS && <span className="text-xs text-danger">{t("Up to {n} domains.", "最多 {n} 个域名。", { n: MAX_COMPETITORS })}</span>}
          </label>
          <label className="grid gap-1.5 text-sm font-medium">{t("Audience or market (optional)", "受众或市场（选填）")}
            <input className={fieldClass} maxLength={300} value={audience} disabled={busy === "create"} onChange={e => { setAudience(e.target.value); setConfirmed(false); }} />
          </label>
        </div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">{t("Output language", "输出语言")}
          <input className={fieldClass} required maxLength={80} value={language} disabled={busy === "create"} onChange={e => { setLanguage(e.target.value); setConfirmed(false); }} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">{t("Depth", "调研深度")}
          <select className={fieldClass} value={profile} disabled={busy === "create"} onChange={e => { setProfile(e.target.value === "standard" ? "standard" : "lite"); setConfirmed(false); }}>
            <option value="lite">{t("Lite: fewer credits", "Lite：更省积分")}</option>
            <option value="standard">{t("Standard: reads more pages, uses more credits", "标准：读取更多页面，消耗更多积分")}</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("Manus bills credits by the work a task takes and cannot say the cost in advance; a research task like this often takes a few hundred credits.", "Manus 按任务实际工作量扣积分，无法事先报价；这类调研任务通常消耗几百积分。")}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={confirmed} disabled={busy === "create" || !history?.connected} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />
        {t("I agree to send these inputs to Manus and use my Manus account credits for this task.", "我同意将以上输入发送至 Manus，并使用我的 Manus 账号积分执行本次研究。")}
      </label>
      <button type="submit" disabled={!ready} className={buttonVariants()}>{busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Telescope className="size-4" />}{t("Start Manus research", "开始 Manus 研究")}</button>
    </form>

    {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">{errorText(error, t)}</p>}

    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-text-strong">{t("Saved tasks", "已保存的任务")}</h3>
        <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={!!busy} onClick={() => load()}>
          <RefreshCw className={busy === "list" ? "size-4 animate-spin" : "size-4"} />{t("Refresh list", "刷新列表")}
        </button>
      </div>
      {!history && busy === "list" && <p role="status" className="text-sm text-muted-foreground">{t("Loading saved tasks…", "正在读取已保存任务…")}</p>}
      {history?.tasks.length === 0 && <p className="text-sm text-muted-foreground">{t("No tasks yet.", "暂无任务。")}</p>}
      {history?.tasks.map(task => {
        const open = expandedId === task.id;
        const taskUrl = safeLink(task.taskUrl);
        return <article key={task.id} className="overflow-hidden rounded-lg border border-border">
          <button type="button" aria-expanded={open} aria-controls={`manus-research-${task.id}`} onClick={() => setExpandedId(open ? null : task.id)}
            className="flex w-full flex-wrap items-center justify-between gap-2 bg-bg-soft px-4 py-3 text-left text-sm hover:bg-muted">
            <span className="min-w-0 flex-1 break-words font-medium text-text-strong">{taskTitle(kind, task)}</span>
            <time dateTime={task.createdAt} className="font-data text-xs text-muted-foreground">{formatDay(task.createdAt, { locale, time: true })}</time>
            <span className="rounded-md border border-border px-2 py-1 text-xs">{statusText(task.status, t)}</span>
          </button>
          <div id={`manus-research-${task.id}`} hidden={!open}>
            {open && <div className="space-y-4 border-t border-border-soft px-4 py-4 text-sm">
              {task.status === "unknown" && <p className="text-warning">{t("Check your task history in Manus before starting another paid task.", "请先在 Manus 账号中核对任务记录，再决定是否新建付费任务。")}</p>}
              {task.status === "waiting" && <p>{t("Open the private task in Manus to provide the requested input.", "请打开 Manus 私有任务，补充所需信息。")}</p>}
              {(task.status === "pending" || task.status === "running") && <p className="text-muted-foreground">{t("Manus is still working; research tasks like this often take 15 minutes or more. Update the result later.", "Manus 仍在工作，这类调研常需 15 分钟以上，稍后再更新结果。")}</p>}
              {task.errorCode && task.status !== "unknown" && <p className="text-danger">{errorText(task.errorCode, t)}</p>}
              {task.summary && <p className="whitespace-pre-wrap break-words leading-6">{task.summary}</p>}
              <Rows kind={kind} task={task} t={t} />
              <div className="flex flex-wrap items-center gap-3">
                {task.refreshable && task.status !== "completed" && <button type="button" disabled={!history.connected || !!busy} onClick={() => void update(task.id)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <RefreshCw className={busy === task.id ? "size-4 animate-spin" : "size-4"} />{t("Update result from Manus", "从 Manus 更新结果")}
                </button>}
                {task.refreshable && task.status === "completed" && task.extracted !== true && <button type="button" disabled={!history.connected || !!busy} onClick={() => void update(task.id)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <RefreshCw className={busy === task.id ? "size-4 animate-spin" : "size-4"} />{t("Read the table again", "重新读取表格")}
                </button>}
                {task.rows.length > 0 && <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} onClick={() => downloadCsv(kind, task)}>
                  <Download className="size-4" />{t("Download CSV", "下载 CSV")}
                </button>}
                {taskUrl && <a href={taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-link">{t("Open private task in Manus", "打开 Manus 私有任务")}<ExternalLink className="size-3.5" aria-hidden /></a>}
              </div>
            </div>}
          </div>
        </article>;
      })}
      {history?.nextCursor && <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={!!busy} onClick={() => load(history.nextCursor!)}>
        {t("Load older tasks", "加载更早的任务")}
      </button>}
    </div>
  </section>;
}
