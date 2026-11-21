"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ExternalLink, Minus, Play, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Locale, Translator } from "@/lib/i18n/shared";
import { RESEARCH_LANGUAGES, RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import { formatDay } from "@/lib/format";
import { checkEstimateUsd, estimateRankRun, monthlyEstimateUsd } from "@/lib/rank-tracking/costs";
import type { RankRow, RankRunRow, RankSettings, RankWorkspace } from "@/lib/rank-tracking/rules";
import type { KeywordHistory } from "@/lib/rank-tracking/tracking";

/** `initial`: a workspace already read (the screen still refreshes it on mount). */
type Props = { siteId: string; initial?: RankWorkspace };
type Filter = "tracked" | "top10" | "down" | "untracked";

const INPUT = "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-500 focus:outline-none";
const DEPTHS = [10, 20, 30, 50, 100] as const;
const usd = (value: number) => `$${value < 1 ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : value.toFixed(2)}`;

function errorText(message: string, t: Translator): string {
  const known: Record<string, string> = {
    "Mark at least one saved keyword for tracking": t("Mark at least one saved keyword for tracking.", "请至少把一个已保存关键词设为追踪。"),
    "Add your DataForSEO login in Settings first": t("Add your DataForSEO login in Settings first.", "请先在“设置”中添加 DataForSEO 登录信息。"),
    "Paid research requires confirmation": t("Confirm the cost before the run starts.", "开始前需要确认费用。"),
    "Research market changed. Reload and confirm again.": t("The research market changed. Reload and confirm again.", "调研市场已变更，请刷新后重新确认。"),
    "Unknown site": t("Site not found.", "找不到这个网站。"),
  };
  return known[message] ?? message;
}

function positionTone(position: number | null): string {
  if (position === null) return "text-muted-foreground";
  if (position <= 3) return "text-success";
  if (position <= 10) return "text-text-strong";
  return "text-muted-foreground";
}

function Position({ value, depth, t }: { value: number | null; depth: number; t: Translator }) {
  if (value === null) return <span className="text-xs text-muted-foreground">{t("Not in top {n}", "未进前 {n}", { n: depth })}</span>;
  return <span className={`inline-flex items-center gap-1.5 font-data text-[13px] ${positionTone(value)}`}>
    <span aria-hidden className={`size-1.5 rounded-full ${value <= 3 ? "bg-success" : value <= 10 ? "bg-warning" : "bg-line-strong"}`} />
    {value}
  </span>;
}

function Movement({ row, t }: { row: RankRow; t: Translator }) {
  switch (row.movement) {
    case "UP": return <span className="inline-flex items-center gap-0.5 font-data text-xs text-success" title={t("Up {n} places since the previous check", "比上次检查上升 {n} 位", { n: row.change ?? 0 })}><ArrowUp size={12} aria-hidden />{row.change}</span>;
    case "DOWN": return <span className="inline-flex items-center gap-0.5 font-data text-xs text-danger" title={t("Down {n} places since the previous check", "比上次检查下降 {n} 位", { n: Math.abs(row.change ?? 0) })}><ArrowDown size={12} aria-hidden />{Math.abs(row.change ?? 0)}</span>;
    case "SAME": return <span className="inline-flex items-center text-xs text-muted-foreground" title={t("Same place as the previous check", "与上次检查持平")}><Minus size={12} aria-hidden /></span>;
    case "ENTERED": return <span className="text-xs text-success">{t("New", "新进入")}</span>;
    case "LEFT": return <span className="text-xs text-danger">{t("Dropped out", "掉出")}</span>;
    default: return null;
  }
}

function runStatusText(run: RankRunRow, t: Translator): string {
  switch (run.status) {
    case "POSTING": return t("Posting", "正在提交");
    case "WAITING": return t("Waiting for results", "等待结果");
    case "SUCCEEDED": return t("Done", "完成");
    case "PARTIAL": return t("Partly done", "部分完成");
    case "FAILED": return t("Failed", "失败");
    case "INTERRUPTED": return t("Interrupted", "已中断");
  }
}

function runErrorText(run: RankRunRow, t: Translator): string | null {
  if (!run.error) return null;
  switch (run.errorCode) {
    case "BUDGET": return t("The budget per run covered {n} of {planned} keywords; the rest were not checked.", "单次预算只够检查 {planned} 个词中的 {n} 个，其余这次未检查。", { n: run.checks, planned: run.planned });
    case "DATAFORSEO_AUTH": return t("DataForSEO refused the saved login. Check it in Settings.", "DataForSEO 拒绝了已保存的登录信息，请在“设置”中检查。");
    case "DATAFORSEO_BALANCE": return t("The DataForSEO balance is too low. Top it up and run again.", "DataForSEO 余额不足，请充值后重新运行。");
    case "INTERRUPTED": return t("The app stopped while posting; what was posted is still collected.", "提交过程中程序停止；已提交的部分仍会收取结果。");
    default: return run.error;
  }
}

/** Positions over time; lower is better, so the line rises as the site moves up. */
function HistoryChart({ history, depth, t }: { history: KeywordHistory; depth: number; t: Translator }) {
  const points = history.checks.filter(c => c.status === "OK");
  if (points.length < 2) return <p className="text-xs text-muted-foreground">{t("The trend shows after two checks.", "检查两次以上后显示趋势。")}</p>;
  const width = 360, height = 96, pad = 8;
  const floor = Math.max(depth, ...points.map(p => p.position ?? 0)) + 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (position: number | null) => pad + (((position ?? floor) - 1) * (height - pad * 2)) / (floor - 1);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.position).toFixed(1)}`).join(" ");
  const label = points.map(p => `${p.at.slice(0, 10)}: ${p.position ?? t("not ranked", "未上榜")}`).join(", ");
  return <figure className="space-y-1">
    <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full max-w-md" role="img" aria-label={t("Measured positions: {list}", "实测排名：{list}", { list: label })}>
      <line x1={pad} x2={width - pad} y1={y(10)} y2={y(10)} className="stroke-border" strokeDasharray="3 3" />
      <path d={line} fill="none" className="stroke-brand-500" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.position)} r={2.5} className={p.position === null ? "fill-danger" : "fill-brand-500"} />)}
    </svg>
    <figcaption className="text-[11px] text-muted-foreground">{t("Dashed line: position 10. Red dots: not in the results read.", "虚线：第 10 名。红点：所读结果中没有网站。")}</figcaption>
  </figure>;
}

function KeywordDetail({ siteId, row, depth, t, locale }: { siteId: string; row: RankRow; depth: number; t: Translator; locale: Locale }) {
  const [history, setHistory] = useState<KeywordHistory | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    fetch(`/api/sites/${siteId}/rank-tracking/history?keyword=${encodeURIComponent(row.keyword)}`, { cache: "no-store" })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(body => { if (!stopped) setHistory(body as KeywordHistory); })
      .catch(() => { if (!stopped) setFailed(true); });
    return () => { stopped = true; };
  }, [siteId, row.keyword]);
  if (failed) return <p className="text-sm text-danger">{t("Could not load the history.", "无法加载历史记录。")}</p>;
  if (!history) return <p className="text-sm text-muted-foreground">{t("Loading…", "加载中…")}</p>;
  const urls = history.checks.filter(c => c.status === "OK" && c.url).map(c => c.url as string);
  const distinctUrls = [...new Set(urls)];
  return <div className="grid gap-5 lg:grid-cols-2">
    <div className="space-y-3">
      <HistoryChart history={history} depth={depth} t={t} />
      {distinctUrls.length > 1 && <div className="space-y-1">
        <p className="text-xs font-medium text-text-strong">{t("Pages that ranked for it", "曾为此词排名的页面")}</p>
        <ul className="space-y-0.5 text-xs text-muted-foreground">{distinctUrls.map(url => <li key={url} className="break-all">{url}</li>)}</ul>
        <p className="text-[11px] text-muted-foreground">{t("Google switching between pages can mean they compete for the keyword.", "Google 在几个页面之间切换，可能说明它们在争同一个词。")}</p>
      </div>}
      {row.gsc && <p className="text-xs text-muted-foreground">{t("Search Console, last 28 days: average position {position}, {clicks} clicks, {impressions} impressions.", "Search Console 近 28 天：平均排名 {position}，点击 {clicks}，展示 {impressions}。", { position: row.gsc.position.toFixed(1), clicks: row.gsc.clicks, impressions: row.gsc.impressions })}</p>}
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium text-text-strong">{t("First ten results", "前 10 名结果")}{history.topAt && <span className="ml-1 font-normal text-muted-foreground">{formatDay(history.topAt, { locale })}</span>}</p>
      {history.top.length === 0 ? <p className="text-xs text-muted-foreground">{t("No results stored yet.", "暂无结果。")}</p> : <ol className="space-y-1 text-xs">{history.top.map(r => <li key={`${r.rank}-${r.url}`} className="flex gap-2">
        <span className="w-5 shrink-0 text-right font-data text-muted-foreground">{r.rank}</span>
        <span className="min-w-0">
          <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className={`inline-flex items-center gap-1 ${row.latest?.url === r.url ? "font-medium text-brand-700" : "text-text-strong"} hover:underline`}>{r.domain}<ExternalLink size={11} aria-hidden /></a>
          {r.title && <span className="block truncate text-muted-foreground">{r.title}</span>}
        </span>
      </li>)}</ol>}
    </div>
  </div>;
}

export default function RankTracking({ siteId, initial }: Props) {
  const { t, locale } = useI18n();
  const [workspace, setWorkspace] = useState<RankWorkspace | null>(initial ?? null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<RankSettings | null>(initial?.settings ?? null);
  const [budget, setBudget] = useState(String(initial?.settings.budgetUsd ?? 1));
  const [confirming, setConfirming] = useState(false);
  const [newKeywords, setNewKeywords] = useState("");
  const [filter, setFilter] = useState<Filter>("tracked");
  const [open, setOpen] = useState<string | null>(null);
  // The latest translator for the loaders, without making them change (and the form reset) when the language changes.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  const apply = useCallback((next: RankWorkspace, resetForm: boolean) => {
    setWorkspace(next);
    if (resetForm) {
      setForm(next.settings);
      setBudget(String(next.settings.budgetUsd));
    }
  }, []);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
    const body = await res.json().catch(() => null);
    const tr = tRef.current;
    if (!res.ok) throw new Error(typeof body?.error === "string" ? errorText(body.error, tr) : tr("The request failed.", "请求失败。"));
    return body;
  }, []);

  const load = useCallback(async (resetForm = false) => {
    try {
      apply(await request(`/api/sites/${siteId}/rank-tracking`) as RankWorkspace, resetForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apply, request, siteId]);

  useEffect(() => { void load(true); }, [load]);

  // While a run is posting or waiting for results, poll its progress; reload everything when it ends.
  const going = !!workspace && (!!workspace.active || workspace.runs.some(r => r.status === "POSTING" || r.status === "WAITING"));
  useEffect(() => {
    if (!going) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const progress = await request(`/api/sites/${siteId}/rank-tracking?view=progress`) as Pick<RankWorkspace, "active" | "runs">;
        if (stopped) return;
        const still = !!progress.active || progress.runs.some(r => r.status === "POSTING" || r.status === "WAITING");
        if (!still) { void load(false); return; }
        setWorkspace(current => current && { ...current, active: progress.active, runs: progress.runs });
      } catch { /* the next tick tries again */ }
    }, 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [going, load, request, siteId]);

  async function act(name: string, run: () => Promise<void>) {
    setBusy(name);
    setError("");
    setNotice("");
    try { await run(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const budgetValue = Number(budget);
  const budgetValid = budget.trim() !== "" && Number.isFinite(budgetValue) && budgetValue >= 0.05 && budgetValue <= 100;
  const draft: RankSettings | null = form && { ...form, budgetUsd: budgetValid ? Math.round(budgetValue * 100) / 100 : form.budgetUsd };
  const dirty = !!workspace && !!draft && JSON.stringify(draft) !== JSON.stringify(workspace.settings);

  const saveSettings = () => act("settings", async () => {
    if (!draft) return;
    apply(await request(`/api/sites/${siteId}/rank-tracking`, { method: "PUT", body: JSON.stringify(draft) }) as RankWorkspace, true);
    setNotice(t("Settings saved.", "设置已保存。"));
  });

  const addKeywords = () => act("add", async () => {
    const keywords = newKeywords.split("\n").map(line => line.trim()).filter(Boolean);
    if (!keywords.length) return;
    const body = await request(`/api/sites/${siteId}/rank-tracking/keywords`, { method: "POST", body: JSON.stringify({ keywords }) }) as
      { tracked: number; operators: number; overLimit: number; workspace: RankWorkspace };
    apply(body.workspace, false);
    setNewKeywords("");
    setFilter("tracked");
    const parts = [t("{n} keywords now tracked.", "已追踪 {n} 个关键词。", { n: body.tracked })];
    if (body.operators) parts.push(t("{n} with search operators were saved but are not tracked.", "{n} 个含搜索指令的词已保存，但不追踪。", { n: body.operators }));
    if (body.overLimit) parts.push(t("{n} were saved without tracking: a site tracks up to {limit} keywords.", "{n} 个词已保存但未追踪：每个网站最多追踪 {limit} 个词。", { n: body.overLimit, limit: body.workspace.limits.tracked }));
    setNotice(parts.join(" "));
  });

  const toggle = (ids: string[], tracked: boolean) => act("toggle", async () => {
    const body = await request(`/api/sites/${siteId}/rank-tracking/keywords`, { method: "PATCH", body: JSON.stringify({ ids, tracked }) }) as
      { updated: number; operators: number; overLimit: number; workspace: RankWorkspace };
    apply(body.workspace, false);
    if (body.overLimit) setNotice(t("A site tracks up to {limit} keywords.", "每个网站最多追踪 {limit} 个词。", { limit: body.workspace.limits.tracked }));
    else if (body.operators) setNotice(t("Keywords with search operators are not tracked.", "含搜索指令的词不追踪。"));
  });

  const startRun = () => act("run", async () => {
    if (!workspace) return;
    const body = await request(`/api/sites/${siteId}/rank-tracking/run`, {
      method: "POST",
      body: JSON.stringify({ provider: "dataforseo", confirmed: true, operations: workspace.estimate.tasks, language: workspace.market.language, location: workspace.market.location }),
    }) as { alreadyActive?: boolean };
    setConfirming(false);
    setNotice(body?.alreadyActive
      ? t("A run is already being posted for this site; nothing new was started.", "这个网站已有一次检查正在提交，没有开始新的检查。")
      : t("The run has started. DataForSEO usually returns the results within a few minutes; they appear here as they arrive.", "检查已开始。DataForSEO 通常几分钟内返回结果，返回后会显示在这里。"));
    await load(false);
  });

  const rows = useMemo(() => {
    const all = workspace?.rows ?? [];
    switch (filter) {
      case "tracked": return all.filter(r => r.tracked);
      case "top10": return all.filter(r => r.tracked && r.latest?.position !== null && r.latest?.position !== undefined && r.latest.position <= 10);
      case "down": return all.filter(r => r.tracked && (r.movement === "DOWN" || r.movement === "LEFT"));
      case "untracked": return all.filter(r => !r.tracked);
    }
  }, [workspace, filter]);

  if (!workspace || !form || !draft) {
    return <section className="panel p-5">
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : <p className="text-sm text-muted-foreground">{t("Loading…", "加载中…")}</p>}
    </section>;
  }

  const s = workspace.summary;
  const zh = locale === "zh";
  const location = RESEARCH_LOCATIONS.find(l => l.value === workspace.market.location);
  const language = RESEARCH_LANGUAGES.find(l => l.value === workspace.market.language);
  const marketText = `${location ? (zh ? location.zh : location.en) : workspace.market.location} · ${language ? (zh ? language.zh : language.en) : workspace.market.language}`;
  const depth = workspace.settings.depth;
  const draftTracked = workspace.rows.filter(r => r.tracked && !r.operator).length;
  const draftEstimate = estimateRankRun(draftTracked, draft.depth, draft.aiOverview);
  const draftMonthly = monthlyEstimateUsd(draftTracked, draft.depth, draft.aiOverview, draft.scheduleDays);
  const waiting = workspace.runs.filter(r => r.status === "POSTING" || r.status === "WAITING");
  const lastFinished = workspace.runs.find(r => r.finishedAt);
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: t("Tracked", "追踪中"), value: String(s.tracked), hint: t("of {limit}", "上限 {limit}", { limit: workspace.limits.tracked }) },
    { label: t("Top 3", "前 3 名"), value: String(s.top3) },
    { label: t("Top 10", "前 10 名"), value: String(s.top10) },
    { label: t("Not in top {n}", "未进前 {n}", { n: depth }), value: String(s.notRanked) },
    { label: t("Moved up", "上升"), value: String(s.up) },
    { label: t("Moved down", "下降"), value: String(s.down) },
    ...(s.aiOverview ? [{ label: t("AI Overview cites you", "AI 概览引用"), value: `${s.aiCited}/${s.aiOverview}`, hint: t("of keywords with one", "出现 AI 概览的词") }] : []),
  ];

  return <section className="space-y-5">
    <div className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-semibold text-text-strong">{t("Measured positions", "实测排名")}</h2>
          <p className="text-sm text-muted-foreground">{t("Where the site ranks on Google for each tracked keyword, read from one results page as a searcher in the market sees it, through your DataForSEO account. Search Console's average position mixes every country and device, so both are shown.", "通过你的 DataForSEO 账户读取 Google 结果页，按目标市场的搜索者视角查看每个追踪词的实际名次。Search Console 的平均排名混合了所有国家和设备，所以两者并列显示。")}</p>
          <p className="text-xs text-muted-foreground">{t("Market: {market} (change it in the site settings) · {device} · first {depth} results", "市场：{market}（在网站设置中修改）· {device} · 读取前 {depth} 名", { market: marketText, device: workspace.settings.device === "mobile" ? t("mobile", "手机") : t("desktop", "电脑"), depth })}</p>
        </div>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void load(false)}><RefreshCw size={14} aria-hidden />{t("Refresh", "刷新")}</button>
      </div>
      {!workspace.credentials && <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">{t("No DataForSEO login is saved. Add it in Settings to check rankings.", "尚未保存 DataForSEO 登录信息，在“设置”中添加后才能检查排名。")} <a className="text-link" href="/settings">{t("Settings", "设置")} →</a></p>}
      {error && <p className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="text-sm text-success" role="status">{notice}</p>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">{tiles.map(tile => <div key={tile.label} className="rounded-lg border border-border-soft bg-bg-section px-3 py-2.5">
        <dt className="text-xs text-muted-foreground">{tile.label}</dt>
        <dd className="mt-1 font-data text-xl text-text-strong">{tile.value}{tile.hint && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{tile.hint}</span>}</dd>
      </div>)}</dl>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <div className="space-y-0.5 text-sm">
          {waiting.length > 0 ? <p className="text-text-strong" role="status">{waiting[0].status === "POSTING"
            ? t("Posting {n} keywords to DataForSEO…", "正在向 DataForSEO 提交 {n} 个词…", { n: waiting[0].checks })
            : t("Waiting for results: {done} of {n} back. They usually arrive within minutes.", "等待结果：已返回 {done}/{n}，通常几分钟内返回。", { done: waiting[0].done, n: waiting[0].checks })}</p>
            : <p><strong className="text-text-strong">{t("{n} checks", "{n} 次检查", { n: workspace.estimate.tasks })}</strong> <span className="text-muted-foreground">{t("about {usd} per run", "每次约 {usd}", { usd: usd(workspace.estimate.usd) })}{workspace.monthlyUsd !== null && t(", about {usd} a month on schedule", "，按计划每月约 {usd}", { usd: usd(workspace.monthlyUsd) })}</span></p>}
          {workspace.estimate.skipped > 0 && <p className="text-xs text-warning">{t("The budget of {budget} per run leaves {n} tracked keywords unchecked.", "单次预算 {budget} 不够，{n} 个追踪词这次不会检查。", { budget: usd(workspace.settings.budgetUsd), n: workspace.estimate.skipped })}</p>}
          {lastFinished && <p className="text-xs text-muted-foreground">{t("Last run {date}: {status}, cost {usd}.", "上次检查 {date}：{status}，花费 {usd}。", { date: formatDay(lastFinished.finishedAt!, { time: true, locale }), status: runStatusText(lastFinished, t), usd: usd(lastFinished.costUsd) })}</p>}
        </div>
        {confirming ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-strong">{t("Check {n} keywords for about {usd}?", "检查 {n} 个词，约 {usd}？", { n: workspace.estimate.tasks, usd: usd(workspace.estimate.usd) })}</span>
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy !== null} onClick={() => void startRun()}>{busy === "run" ? t("Starting…", "正在开始…") : t("Confirm and pay", "确认并付费")}</button>
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => setConfirming(false)}>{t("Cancel", "取消")}</button>
        </div> : <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          disabled={busy !== null || !workspace.credentials || workspace.estimate.tasks === 0 || dirty || !!workspace.active}
          title={dirty ? t("Save the settings first", "请先保存设置") : undefined}
          onClick={() => setConfirming(true)}><Play size={14} aria-hidden />{t("Check rankings now", "立即检查排名")}</button>}
      </div>

      <details className="rounded-lg border border-border p-4" open={!workspace.saved}>
        <summary className="cursor-pointer font-medium">{t("Device, depth and schedule", "设备、深度与计划")}</summary>
        <div className="mt-4 space-y-4 text-sm">
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Device", "设备")}</span>
              <select className={INPUT} value={form.device} onChange={e => setForm({ ...form, device: e.target.value === "mobile" ? "mobile" : "desktop" })}>
                <option value="desktop">{t("Desktop", "电脑")}</option>
                <option value="mobile">{t("Mobile", "手机")}</option>
              </select>
            </label>
            <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Results read per keyword", "每个词读取的结果数")}</span>
              <select className={INPUT} value={form.depth} onChange={e => setForm({ ...form, depth: Number(e.target.value) })}>
                {DEPTHS.map(d => <option key={d} value={d}>{t("First {n} ({usd} each)", "前 {n} 名（每词 {usd}）", { n: d, usd: usd(checkEstimateUsd(d, false)) })}</option>)}
              </select>
            </label>
            <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Schedule", "定期检查")}</span>
              <select className={INPUT} value={form.scheduleDays ?? ""} onChange={e => setForm({ ...form, scheduleDays: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t("Only when started by hand", "仅手动检查")}</option>
                <option value="1">{t("Every day", "每天")}</option>
                <option value="3">{t("Every 3 days", "每 3 天")}</option>
                <option value="7">{t("Every week", "每周")}</option>
                <option value="14">{t("Every 2 weeks", "每 2 周")}</option>
                <option value="30">{t("Every 30 days", "每 30 天")}</option>
              </select>
            </label>
            <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Budget per run (USD)", "单次预算（美元）")}</span>
              <input className={`${INPUT} w-28`} type="number" min={0.05} max={100} step={0.05} value={budget} aria-invalid={!budgetValid} onChange={e => setBudget(e.target.value)} />
            </label>
          </div>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={form.aiOverview} onChange={e => setForm({ ...form, aiOverview: e.target.checked })} />
            <Sparkles size={14} aria-hidden className="text-brand-700" />
            {t("Also load Google's AI Overview and check whether it cites the site (+{usd} per keyword)", "同时加载 Google AI 概览，查看是否引用网站（每词 +{usd}）", { usd: usd(checkEstimateUsd(10, true) - checkEstimateUsd(10, false)) })}
          </label>
          {!budgetValid && <p className="text-xs text-danger">{t("Enter a budget from $0.05 to $100.", "请输入 0.05 到 100 美元之间的预算。")}</p>}
          <p className="text-xs text-muted-foreground">{draftMonthly !== null
            ? t("With these settings: {n} keywords, about {usd} per run and about {monthly} a month.", "按此设置：{n} 个词，每次约 {usd}，每月约 {monthly}。", { n: draftTracked, usd: usd(draftEstimate.usd), monthly: usd(draftMonthly) })
            : t("With these settings: {n} keywords, about {usd} per run.", "按此设置：{n} 个词，每次约 {usd}。", { n: draftTracked, usd: usd(draftEstimate.usd) })}</p>
          <p className="text-xs text-muted-foreground">{t("DataForSEO bills per page of 10 results when a check is posted, so reading the first 30 results costs up to three pages. Google sometimes returns fewer results and the charge is then lower.", "DataForSEO 在提交时按每 10 个结果一页计费，读取前 30 名最多算三页。Google 有时返回的结果较少，费用也会相应降低。")}</p>
          {draft.scheduleDays !== null && !workspace.scheduler && <p className="text-xs text-warning">{t("Scheduled tasks are turned off on this server (SCHEDULER_ENABLED or SCHEDULE_RANK_TRACKING is false), so only checks started by hand will happen.", "本服务器关闭了定时任务（SCHEDULER_ENABLED 或 SCHEDULE_RANK_TRACKING 为 false），只会执行手动检查。")}</p>}
          <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy !== null || !budgetValid || (!dirty && workspace.saved)} onClick={() => void saveSettings()}>{busy === "settings" ? t("Saving…", "保存中…") : t("Save settings", "保存设置")}</button>
        </div>
      </details>
    </div>

    <div className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Filter keywords", "筛选关键词")}>
          {([
            ["tracked", t("Tracked", "追踪中")],
            ["top10", t("Top 10", "前 10 名")],
            ["down", t("Moved down", "下降")],
            ["untracked", t("Saved, not tracked", "已保存未追踪")],
          ] as [Filter, string][]).map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id}
            className={`rounded-md px-3 py-1.5 text-sm ${filter === id ? "bg-bg-section text-text-strong" : "text-muted-foreground hover:text-text-strong"}`}
            onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        <div className="grid w-full gap-2 md:w-auto md:grid-cols-[22rem_auto]">
          <textarea className={`${INPUT} min-h-10 w-full`} rows={2} placeholder={t("Keywords to track, one per line", "要追踪的关键词，每行一个")} value={newKeywords} onChange={e => setNewKeywords(e.target.value)} />
          <button type="button" className="inline-flex items-center justify-center gap-1 self-start rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50" disabled={busy !== null || !newKeywords.trim()} onClick={() => void addKeywords()}><Plus size={14} aria-hidden />{t("Track", "追踪")}</button>
        </div>
      </div>

      {rows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{filter === "untracked"
        ? t("Every saved keyword is tracked.", "所有已保存关键词都在追踪中。")
        : filter === "tracked" ? t("No keyword is tracked yet. Add keywords above, or track saved ones from the last tab.", "还没有追踪的关键词。在上方添加，或在最后一个标签中把已保存的词设为追踪。")
        : t("No keyword matches.", "没有符合条件的关键词。")}</p>
      : <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="w-8 py-2 font-normal"><span className="sr-only">{t("Details", "详情")}</span></th>
          <th className="py-2 font-normal">{t("Keyword", "关键词")}</th>
          <th className="py-2 text-right font-normal">{t("Measured", "实测排名")}</th>
          <th className="py-2 font-normal"><span className="sr-only">{t("Change", "变化")}</span></th>
          <th className="py-2 text-right font-normal" title={t("Search Console average position, last 28 days", "Search Console 近 28 天平均排名")}>{t("GSC avg.", "GSC 平均")}</th>
          <th className="py-2 pl-4 font-normal">{t("Ranking page", "排名页面")}</th>
          <th className="py-2 font-normal">{t("AI Overview", "AI 概览")}</th>
          <th className="py-2 font-normal">{t("Checked", "检查时间")}</th>
          <th className="py-2 text-right font-normal">{t("Track", "追踪")}</th>
        </tr></thead>
        <tbody>{rows.map(row => {
          const expanded = open === row.id;
          const path = row.latest?.url ? row.latest.url.replace(/^https?:\/\/[^/]+/, "") || "/" : null;
          return <Fragment key={row.id}>
            <tr className="border-b border-border-soft align-middle">
              <td className="py-2">{row.latest && <button type="button" className="rounded p-1 text-muted-foreground hover:text-text-strong" aria-expanded={expanded} aria-label={t("Show history", "查看历史")} onClick={() => setOpen(expanded ? null : row.id)}>{expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}</button>}</td>
              <td className="py-2 pr-3 text-text-strong">{row.keyword}{row.operator && <span className="ml-2 text-xs text-muted-foreground">{t("search operator, not checked", "含搜索指令，不检查")}</span>}{row.failure && <span className="ml-2 text-xs text-danger" title={row.failure.error}>{t("last check failed", "上次检查失败")}</span>}</td>
              <td className="py-2 text-right">{row.latest ? <Position value={row.latest.position} depth={depth} t={t} /> : <span className="text-xs text-muted-foreground">{row.tracked ? t("Not checked yet", "尚未检查") : "-"}</span>}</td>
              <td className="py-2 pl-2"><Movement row={row} t={t} /></td>
              <td className="py-2 text-right font-data text-xs text-muted-foreground">{row.gsc ? row.gsc.position.toFixed(1) : "-"}</td>
              <td className="max-w-64 py-2 pl-4">{path ? <span className="block truncate text-xs text-text-strong" title={row.latest!.url!}>{path}{row.urlChanged && <span className="ml-1.5 text-warning">{t("changed", "已变化")}</span>}</span> : <span className="text-xs text-muted-foreground">-</span>}</td>
              <td className="py-2 text-xs">{row.latest?.aiOverview ? (row.latest.aiCited === true ? <span className="text-success">{t("Cites you", "引用了你")}</span> : row.latest.aiCited === false ? <span className="text-muted-foreground">{t("Shown, not citing you", "出现，未引用你")}</span> : <span className="text-muted-foreground">{t("Shown", "出现")}</span>) : <span className="text-muted-foreground">-</span>}</td>
              <td className="py-2 text-xs text-muted-foreground">{row.latest ? formatDay(row.latest.checkedAt, { locale }) : "-"}</td>
              <td className="py-2 text-right"><input type="checkbox" checked={row.tracked} disabled={busy !== null || (row.operator && !row.tracked)} aria-label={t("Track {keyword}", "追踪 {keyword}", { keyword: row.keyword })} onChange={e => void toggle([row.id], e.target.checked)} /></td>
            </tr>
            {expanded && <tr className="border-b border-border-soft bg-bg-soft"><td colSpan={9} className="p-4"><KeywordDetail siteId={siteId} row={row} depth={depth} t={t} locale={locale} /></td></tr>}
          </Fragment>;
        })}</tbody>
      </table></div>}
      {filter === "untracked" && rows.length > 1 && <button type="button" className="text-sm text-link disabled:opacity-50" disabled={busy !== null} onClick={() => void toggle(rows.filter(r => !r.operator).map(r => r.id), true)}>{t("Track all of these", "全部设为追踪")}</button>}
    </div>

    {workspace.runs.length > 0 && <div className="panel p-5">
      <h3 className="mb-3 font-medium text-text-strong">{t("Recent runs", "最近的检查")}</h3>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">{t("Started", "开始时间")}</th>
          <th className="py-2 font-normal">{t("Source", "来源")}</th>
          <th className="py-2 font-normal">{t("Status", "状态")}</th>
          <th className="py-2 text-right font-normal">{t("Keywords", "词数")}</th>
          <th className="py-2 text-right font-normal">{t("Cost", "花费")}</th>
          <th className="py-2 pl-4 font-normal">{t("Note", "说明")}</th>
        </tr></thead>
        <tbody>{workspace.runs.map(run => <tr key={run.id} className="border-b border-border-soft">
          <td className="py-2 text-xs text-muted-foreground">{formatDay(run.startedAt, { time: true, locale })}</td>
          <td className="py-2 text-xs">{run.source === "schedule" ? t("Scheduled", "定期") : t("By hand", "手动")}</td>
          <td className={`py-2 text-xs ${run.status === "FAILED" ? "text-danger" : run.status === "PARTIAL" || run.status === "INTERRUPTED" ? "text-warning" : "text-text-strong"}`}>{runStatusText(run, t)}</td>
          <td className="py-2 text-right font-data text-xs">{run.done}/{run.checks}</td>
          <td className="py-2 text-right font-data text-xs">{usd(run.costUsd)}</td>
          <td className="py-2 pl-4 text-xs text-muted-foreground">{runErrorText(run, t) ?? `${run.device === "mobile" ? t("mobile", "手机") : t("desktop", "电脑")} · ${t("first {n}", "前 {n} 名", { n: run.depth })}${run.aiOverview ? ` · ${t("AI Overview", "AI 概览")}` : ""}`}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}
  </section>;
}
