"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import { TASK_ESTIMATE_USD } from "@/lib/geo/costs";
import { GEO_PLATFORMS, geoPlatform, TRACKED_PLATFORMS, type GeoPlatformId } from "@/lib/geo/platforms";
import type { LatestCell, RunRow, TrackingSettings, TrackingWorkspace } from "@/lib/geo/tracking";
import type { BrandEntity } from "@/lib/geo/visibility-rules";
import { geoErrorMessage } from "./geo-errors";
import { announceGeoUpdate } from "./geo-events";

type Props = { siteId: string; domain: string };
type Answer = {
  id: string; prompt: string; platform: string; source: string; status: string; text: string | null; error: string | null;
  createdAt: string; costUsd: number; meta: { model?: string | null; consulted?: number; fanOut?: string[]; organicRank?: number | null };
  analysis: { ownMentioned: boolean; ownCited: boolean; ownRank: number | null; mentionRank: number | null; mentions: { name: string; own: boolean; count: number }[] };
  citations: { url: string; domain: string; title: string | null; rank: number; owner: string | null }[];
  history: { id: string; createdAt: string; source: string; status: string; ownMentioned: boolean; ownCited: boolean }[];
};
type EntityDraft = { name: string; aliases: string; domains: string };

const MAX_COMPETITORS = 10;
const INPUT = "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-500 focus:outline-none";
const list = (value: string) => value.split(/[,，\n]/).map(v => v.trim()).filter(Boolean);
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const usd = (value: number) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

function draftOf(entity: BrandEntity, skipDomain?: string): EntityDraft {
  return { name: entity.name, aliases: entity.aliases.join(", "), domains: entity.domains.filter(d => d !== skipDomain).join(", ") };
}
function entityOf(draft: EntityDraft): BrandEntity {
  return { name: draft.name.trim(), aliases: list(draft.aliases), domains: list(draft.domains) };
}

function platformName(id: string, locale: string): string {
  const platform = geoPlatform(id as GeoPlatformId);
  return platform ? (locale === "zh" ? platform.nameZh : platform.name) : id;
}

function runStatus(run: RunRow, t: Translator): string {
  return {
    RUNNING: t("Running", "进行中"), SUCCEEDED: t("Done", "完成"), PARTIAL: t("Partly done", "部分完成"),
    FAILED: t("Failed", "失败"), INTERRUPTED: t("Interrupted", "已中断"),
  }[run.status];
}

function runError(run: RunRow, t: Translator): string | null {
  const known: Record<string, [string, string]> = {
    BUDGET: ["Stopped at the budget per run.", "达到单次预算上限后停止。"],
    TIME_LIMIT: ["Stopped at this host's time limit. Run again to continue.", "达到主机运行时间上限后停止，再运行一次可继续。"],
    DATAFORSEO_AUTH: ["DataForSEO refused the saved login. Check it in Settings.", "DataForSEO 拒绝了保存的登录信息，请在设置中检查。"],
    DATAFORSEO_BALANCE: ["The DataForSEO balance is too low.", "DataForSEO 余额不足。"],
    INTERRUPTED: ["Interrupted.", "已中断。"],
  };
  const message = run.errorCode ? known[run.errorCode] : undefined;
  return message ? t(message[0], message[1]) : run.error;
}

type Mark = "CITED" | "NAMED" | "NOT_NAMED" | "NO_ANSWER" | "FAILED" | "NONE";

function mark(cell: LatestCell | undefined, t: Translator): { kind: Mark; title: string } {
  if (!cell) return { kind: "NONE", title: t("No answer yet", "尚无回答") };
  if (cell.status === "FAILED") return { kind: "FAILED", title: cell.error ?? t("Failed", "失败") };
  if (cell.status === "NO_ANSWER") return { kind: "NO_ANSWER", title: t("The platform showed no AI answer", "平台未给出 AI 回答") };
  if (cell.ownCited) return { kind: "CITED", title: t("Cited (source #{rank})", "被引用（第 {rank} 个来源）", { rank: cell.ownRank ?? "?" }) };
  if (cell.ownMentioned) return { kind: "NAMED", title: t("Named, not cited", "被提及但未引用") };
  return { kind: "NOT_NAMED", title: cell.competitors.length ? t("Not named; names {list}", "未提及；提到了 {list}", { list: cell.competitors.join(", ") }) : t("Not named", "未提及") };
}

/** The grid's marks: dots for named and cited, a dash for no AI answer, the alert icon for a failure. */
function MarkIcon({ kind }: { kind: Mark }) {
  if (kind === "FAILED") return <AlertTriangle size={14} className="text-danger" aria-hidden />;
  if (kind === "NO_ANSWER" || kind === "NONE") return <span className="text-muted-foreground" aria-hidden>–</span>;
  const style = kind === "CITED" ? "bg-success" : kind === "NAMED" ? "bg-warning" : "border border-text-faint";
  return <span className={`inline-block size-2.5 rounded-full ${style}`} aria-hidden />;
}

function AnswerPanel({ siteId, answerId, onClose, onDeleted }: { siteId: string; answerId: string; onClose: () => void; onDeleted: (workspace: TrackingWorkspace) => void }) {
  const { t, locale } = useI18n();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [current, setCurrent] = useState(answerId);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    fetch(`/api/sites/${siteId}/geo/tracking/answers?id=${encodeURIComponent(current)}`, { cache: "no-store" })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("Could not load the answer.", "无法加载回答。")));
        if (live) setAnswer(body as Answer);
      })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [siteId, current, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove() {
    if (!answer || !window.confirm(t("Delete this recorded answer?", "删除这条手动记录的回答？"))) return;
    const res = await fetch(`/api/sites/${siteId}/geo/tracking/answers?id=${encodeURIComponent(answer.id)}`, { method: "DELETE" });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError((typeof body?.error === "string" ? geoErrorMessage(body.error, t) : t("Deleting failed.", "删除失败。"))); return; }
    onDeleted(body as TrackingWorkspace);
    onClose();
  }

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
    <aside className="h-full w-full max-w-2xl overflow-y-auto bg-bg p-5 shadow-xl" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("Answer", "回答")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold">{answer ? platformName(answer.platform, locale) : t("Answer", "回答")}</h3>
        <button type="button" className="rounded p-1 hover:bg-muted" onClick={onClose} aria-label={t("Close", "关闭")}><X size={16} /></button>
      </div>
      {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
      {answer && <div className="mt-3 space-y-4 text-sm">
        <div className="rounded-md bg-muted/40 p-3"><div className="text-xs text-muted-foreground">{t("Prompt", "提示词")}</div>{answer.prompt}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{new Date(answer.createdAt).toLocaleString()}</span>
          <span>{answer.source === "MANUAL" ? t("Recorded by hand", "手动记录") : "DataForSEO"}</span>
          {answer.meta.model && <span>{t("Model", "模型")}: {answer.meta.model}</span>}
          {answer.costUsd > 0 && <span>{usd(answer.costUsd)}</span>}
          {answer.meta.organicRank != null && <span>{t("Organic rank on the same page: {n}", "同一结果页自然排名：{n}", { n: answer.meta.organicRank })}</span>}
        </div>
        {answer.status === "OK" && <div className="flex flex-wrap gap-2">
          <span className={`rounded px-2 py-0.5 text-xs ${answer.analysis.ownMentioned ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}>{answer.analysis.ownMentioned ? t("Brand named", "提及品牌") : t("Brand not named", "未提及品牌")}{answer.analysis.mentionRank ? ` · #${answer.analysis.mentionRank}` : ""}</span>
          <span className={`rounded px-2 py-0.5 text-xs ${answer.analysis.ownCited ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"}`}>{answer.analysis.ownCited ? t("Site cited (source #{n})", "引用网站（第 {n} 个来源）", { n: answer.analysis.ownRank ?? "?" }) : t("Site not cited", "未引用网站")}</span>
          {answer.analysis.mentions.filter(m => !m.own).map(m => <span key={m.name} className="rounded bg-muted px-2 py-0.5 text-xs">{m.name} × {m.count}</span>)}
        </div>}
        {answer.status === "NO_ANSWER" && <p className="text-muted-foreground">{t("The platform gave no AI answer for this prompt.", "平台对这个提示词没有给出 AI 回答。")}</p>}
        {answer.status === "FAILED" && <p className="text-danger">{answer.error}</p>}
        {answer.citations.length > 0 && <div>
          <div className="font-medium">{t("Sources", "来源")}</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs">{answer.citations.map(c => <li key={c.url} className={c.owner ? "font-medium" : ""}>
            <a href={c.url} target="_blank" rel="noreferrer noopener" className="break-all text-link">{c.title || c.url}</a>
            <span className="text-muted-foreground"> · {c.domain}{c.owner ? ` · ${c.owner}` : ""}</span>
          </li>)}</ol>
        </div>}
        {answer.meta.fanOut && answer.meta.fanOut.length > 0 && <div className="text-xs"><span className="font-medium">{t("Searches it ran", "它执行的搜索")}: </span>{answer.meta.fanOut.join(" · ")}</div>}
        {answer.text && <div><div className="font-medium">{t("Answer", "回答")}</div><div className="mt-1 max-h-[45vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border p-3 text-xs leading-relaxed">{answer.text}</div></div>}
        {answer.history.length > 1 && <div>
          <div className="font-medium">{t("Earlier answers", "历史回答")}</div>
          <ul className="mt-1 space-y-0.5 text-xs">{answer.history.map(h => <li key={h.id}>
            <button type="button" className={`text-left hover:underline ${h.id === answer.id ? "font-medium" : ""}`} onClick={() => setCurrent(h.id)}>
              {new Date(h.createdAt).toLocaleDateString()} · {h.status === "OK" ? (h.ownCited ? t("cited", "引用") : h.ownMentioned ? t("named", "提及") : t("not named", "未提及")) : h.status === "NO_ANSWER" ? t("no AI answer", "无 AI 回答") : t("failed", "失败")}{h.source === "MANUAL" ? ` · ${t("by hand", "手动")}` : ""}
            </button>
          </li>)}</ul>
        </div>}
        {answer.source === "MANUAL" && <button type="button" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-danger" onClick={() => void remove()}><Trash2 size={14} />{t("Delete this answer", "删除这条回答")}</button>}
      </div>}
    </aside>
  </div>;
}

export default function GeoTracking({ siteId, domain }: Props) {
  const { t, locale } = useI18n();
  const [workspace, setWorkspace] = useState<TrackingWorkspace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [own, setOwn] = useState<EntityDraft>({ name: "", aliases: "", domains: "" });
  const [competitors, setCompetitors] = useState<EntityDraft[]>([]);
  const [platforms, setPlatforms] = useState<GeoPlatformId[]>([]);
  const [scheduleDays, setScheduleDays] = useState<number | null>(null);
  const [budget, setBudget] = useState("1");
  const [newPrompts, setNewPrompts] = useState("");
  const [newTag, setNewTag] = useState("");
  const [confirming, setConfirming] = useState<"full" | "trial" | null>(null);
  const [openAnswer, setOpenAnswer] = useState<string | null>(null);
  const [manual, setManual] = useState({ promptId: "", platform: "COPILOT" as string, status: "OK" as "OK" | "NO_ANSWER", text: "", citations: "" });
  const wasActive = useRef(false);
  // The latest translator, without making the loaders change (and the form reset) when the language changes.
  const tRef = useRef(t);
  tRef.current = t;

  const apply = useCallback((next: TrackingWorkspace, resetForm: boolean) => {
    setWorkspace(next);
    if (resetForm) {
      const brands = next.settings?.brands;
      setOwn(brands ? draftOf(brands.own, next.domain) : { name: next.domain, aliases: "", domains: "" });
      setCompetitors(brands ? brands.competitors.map(c => draftOf(c)) : []);
      setPlatforms(next.settings?.platforms ?? ["CHATGPT", "GOOGLE_AIO", "PERPLEXITY"]);
      setScheduleDays(next.settings?.scheduleDays ?? null);
      setBudget(String(next.settings?.budgetUsd ?? 1));
    }
    if (wasActive.current && !next.active) announceGeoUpdate();
    wasActive.current = !!next.active;
  }, []);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
    const body = await res.json().catch(() => null);
    const tr = tRef.current;
    if (!res.ok) throw new Error(typeof body?.error === "string" ? geoErrorMessage(body.error, tr) : tr("The request failed.", "请求失败。"));
    return body;
  }, []);

  const load = useCallback(async (resetForm = false) => {
    try {
      apply(await request(`/api/sites/${siteId}/geo/tracking`) as TrackingWorkspace, resetForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apply, request, siteId]);

  useEffect(() => { void load(true); }, [load]);
  // While a run is going, poll only its progress; reload everything when it ends.
  const active = !!workspace?.active;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const progress = await request(`/api/sites/${siteId}/geo/tracking?view=progress`) as Pick<TrackingWorkspace, "active" | "runs">;
        if (stopped) return;
        if (!progress.active) { void load(false); return; }
        setWorkspace(current => current && {
          ...current,
          active: progress.active,
          runs: progress.runs[0] ? [progress.runs[0], ...current.runs.filter(r => r.id !== progress.runs[0].id)] : current.runs,
        });
      } catch { /* the next tick tries again */ }
    }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, load, request, siteId]);

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

  const saveSettings = () => act("settings", async () => {
    const settings: TrackingSettings = {
      brands: { own: entityOf(own), competitors: competitors.filter(c => c.name.trim()).map(entityOf) },
      platforms, scheduleDays, budgetUsd: Number(budget),
    };
    apply(await request(`/api/sites/${siteId}/geo/tracking`, { method: "PUT", body: JSON.stringify(settings) }) as TrackingWorkspace, true);
    setNotice(t("Settings saved.", "设置已保存。"));
  });

  const addPrompts = () => act("prompts", async () => {
    const prompts = newPrompts.split("\n").map(line => line.trim()).filter(Boolean).map(text => ({ text, tag: newTag.trim() || null }));
    if (!prompts.length) return;
    const body = await request(`/api/sites/${siteId}/geo/tracking/prompts`, { method: "POST", body: JSON.stringify({ prompts }) }) as { added: number; skipped: number; workspace: TrackingWorkspace };
    apply(body.workspace, false);
    setNewPrompts("");
    setNotice(t("{added} prompts added, {skipped} already tracked.", "已添加 {added} 个提示词，{skipped} 个已存在。", { added: body.added, skipped: body.skipped }));
  });

  const togglePrompt = (id: string, active: boolean) => act("prompt:" + id, async () => {
    apply(await request(`/api/sites/${siteId}/geo/tracking/prompts`, { method: "PATCH", body: JSON.stringify({ id, active }) }) as TrackingWorkspace, false);
  });

  const deletePrompt = (id: string) => {
    if (!window.confirm(t("Delete this prompt and all its answers?", "删除这个提示词及其全部回答？"))) return;
    void act("prompt:" + id, async () => {
      apply(await request(`/api/sites/${siteId}/geo/tracking/prompts?id=${encodeURIComponent(id)}`, { method: "DELETE" }) as TrackingWorkspace, false);
    });
  };

  const startRun = (kind: "full" | "trial") => act("run", async () => {
    if (!workspace) return;
    const trial = kind === "trial";
    const body = await request(`/api/sites/${siteId}/geo/tracking/run`, {
      method: "POST",
      body: JSON.stringify({
        provider: "dataforseo", confirmed: true, trial,
        operations: trial ? workspace.trialEstimate.tasks : workspace.estimate.tasks,
        language: workspace.market.language, location: workspace.market.location,
      }),
    }) as { alreadyActive?: boolean };
    setConfirming(null);
    setNotice(body?.alreadyActive
      ? t("A run is already queued or running for this site; nothing new was started.", "这个网站已有运行在排队或进行中，没有开始新的运行。")
      : trial
        ? t("The trial run has started: one prompt per platform. Check the answers and the cost below before a full run.", "试运行已开始：每个平台一个提示词。完整运行前，请先在下方核对回答和花费。")
        : t("The run has started. Answers appear as they arrive.", "已开始运行，回答会陆续出现。"));
    await load(false);
  });

  const saveManual = () => act("manual", async () => {
    const body = await request(`/api/sites/${siteId}/geo/tracking/answers`, {
      method: "POST",
      body: JSON.stringify({ promptId: manual.promptId, platform: manual.platform, status: manual.status, text: manual.status === "OK" ? manual.text : "", citations: manual.citations.split(/\s+/).filter(Boolean) }),
    }) as { id: string; workspace: TrackingWorkspace };
    apply(body.workspace, false);
    setManual(m => ({ ...m, text: "", citations: "" }));
    setNotice(t("Answer recorded.", "回答已记录。"));
    announceGeoUpdate();
  });

  const activePrompts = useMemo(() => workspace?.prompts.filter(p => p.active) ?? [], [workspace]);
  const cells = useMemo(() => new Map((workspace?.latest.cells ?? []).map(c => [`${c.promptId}\0${c.platform}`, c])), [workspace]);
  const columns = useMemo(() => {
    const ids = new Set<string>([...(workspace?.settings?.platforms ?? []), ...(workspace?.latest.cells ?? []).map(c => c.platform)]);
    return GEO_PLATFORMS.map(p => p.id).filter(id => ids.has(id));
  }, [workspace]);
  const running = workspace?.runs.find(r => r.status === "RUNNING");
  const saved = workspace?.settings;
  const settingsChanged = !!saved && (JSON.stringify([...saved.platforms].sort()) !== JSON.stringify([...platforms].sort()));

  if (!workspace) {
    return <section className="panel p-5"><h2 className="font-semibold">{t("Prompt tracking", "提示词跟踪")}</h2>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : <p className="mt-2 text-sm text-muted-foreground">{t("Loading…", "加载中…")}</p>}</section>;
  }

  return <section className="panel space-y-5 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">{t("Prompt tracking", "提示词跟踪")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("Ask each platform the questions your customers ask and see whether its answers name or cite the site. ChatGPT, Gemini, Google AI Overviews, AI Mode, Perplexity and Claude are asked through your DataForSEO account (paid per task); for Copilot, Grok, Meta AI and DeepSeek record what you see in their apps.", "向各平台提出客户会问的问题，看回答是否提及或引用网站。ChatGPT、Gemini、Google AI 概览、AI 模式、Perplexity 和 Claude 通过你的 DataForSEO 账户查询（按任务计费）；Copilot、Grok、Meta AI 和 DeepSeek 请把在其应用中看到的回答手动记下。")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("Market: {language} · location {location} (change it in the site's research settings).", "市场：{language} · 地区代码 {location}（在网站的调研设置中修改）。", { language: workspace.market.language, location: workspace.market.location })}</p>
      </div>
      <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void load(false)}><RefreshCw size={14} />{t("Refresh", "刷新")}</button>
    </div>
    {!workspace.credentials && <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">{t("No DataForSEO login is saved. Add it in Settings to ask platforms automatically; you can still record answers by hand.", "尚未保存 DataForSEO 登录信息。在“设置”中添加后即可自动查询；也可以继续手动记录回答。")} <a className="text-link" href="/settings">{t("Settings", "设置")} →</a></p>}
    {error && <p className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
    {notice && <p className="text-sm text-success" role="status">{notice}</p>}

    <details className="rounded-lg border border-border p-4" open={!saved}>
      <summary className="cursor-pointer font-medium">{t("Brands, platforms and schedule", "品牌、平台与计划")}</summary>
      <div className="mt-4 space-y-4 text-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1"><span className="text-xs text-muted-foreground">{t("Your brand", "你的品牌")}</span><input className={`${INPUT} w-full`} value={own.name} maxLength={80} onChange={e => setOwn({ ...own, name: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">{t("Other names (comma-separated)", "其他名称（逗号分隔）")}</span><input className={`${INPUT} w-full`} value={own.aliases} onChange={e => setOwn({ ...own, aliases: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">{t("Other domains ({domain} is included)", "其他域名（已包含 {domain}）", { domain })}</span><input className={`${INPUT} w-full`} value={own.domains} onChange={e => setOwn({ ...own, domains: e.target.value })} /></label>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t("Competitors", "竞品")}</div>
          {competitors.map((c, i) => <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <input className={INPUT} placeholder={t("Name", "名称")} value={c.name} maxLength={80} onChange={e => setCompetitors(competitors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input className={INPUT} placeholder={t("Other names", "其他名称")} value={c.aliases} onChange={e => setCompetitors(competitors.map((x, j) => j === i ? { ...x, aliases: e.target.value } : x))} />
            <input className={INPUT} placeholder={t("Domains", "域名")} value={c.domains} onChange={e => setCompetitors(competitors.map((x, j) => j === i ? { ...x, domains: e.target.value } : x))} />
            <button type="button" className="rounded p-2 text-muted-foreground hover:text-danger" aria-label={t("Remove", "移除")} onClick={() => setCompetitors(competitors.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>)}
          {competitors.length < MAX_COMPETITORS && <button type="button" className="inline-flex items-center gap-1 text-sm text-link" onClick={() => setCompetitors([...competitors, { name: "", aliases: "", domains: "" }])}><Plus size={14} />{t("Add a competitor", "添加竞品")}</button>}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">{t("Platforms to ask through DataForSEO (estimated cost per prompt)", "通过 DataForSEO 查询的平台（每个提示词的预估费用）")}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">{TRACKED_PLATFORMS.map(id => <label key={id} className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={platforms.includes(id)} onChange={e => setPlatforms(e.target.checked ? [...platforms, id] : platforms.filter(p => p !== id))} />
            {platformName(id, locale)} <span className="text-xs text-muted-foreground">≈{usd(TASK_ESTIMATE_USD[id] ?? 0)}</span>
          </label>)}</div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Schedule", "定期运行")}</span>
            <select className={INPUT} value={scheduleDays ?? ""} onChange={e => setScheduleDays(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("Only when started by hand", "仅手动运行")}</option>
              <option value="7">{t("Every 7 days", "每 7 天")}</option>
              <option value="14">{t("Every 14 days", "每 14 天")}</option>
              <option value="30">{t("Every 30 days", "每 30 天")}</option>
            </select>
          </label>
          <label className="space-y-1"><span className="block text-xs text-muted-foreground">{t("Budget per run (USD)", "单次运行预算（美元）")}</span>
            <input className={`${INPUT} w-28`} type="number" min={0.05} max={100} step={0.05} value={budget} aria-invalid={!budgetValid} onChange={e => setBudget(e.target.value)} />
          </label>
          <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy !== null || !own.name.trim() || !budgetValid} onClick={() => void saveSettings()}>{busy === "settings" ? t("Saving…", "保存中…") : t("Save settings", "保存设置")}</button>
        </div>
        {!budgetValid && <p className="text-xs text-danger">{t("Enter a budget from $0.05 to $100.", "请输入 0.05 到 100 美元之间的预算。")}</p>}
        {scheduleDays !== null && !workspace.scheduler && <p className="text-xs text-warning">{t("Scheduled tasks are turned off on this server (SCHEDULER_ENABLED or SCHEDULE_GEO_TRACKING is false), so only runs started by hand will happen.", "本服务器关闭了定时任务（SCHEDULER_ENABLED 或 SCHEDULE_GEO_TRACKING 为 false），只会执行手动运行。")}</p>}
        {scheduleDays !== null && <p className="text-xs text-muted-foreground">{t("Scheduled runs use the same budget and start within the scheduler's next pass after the interval; a run started by hand resets the interval.", "定期运行使用相同预算，间隔到期后在调度器下一轮启动；手动运行会重新计算间隔。")}</p>}
      </div>
    </details>

    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{t("Prompts", "提示词")} <span className="text-xs font-normal text-muted-foreground">{t("{n} of 50 active", "已启用 {n}/50", { n: activePrompts.length })}</span></h3>
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_auto]">
        <textarea className={`${INPUT} min-h-20 w-full`} placeholder={t("One prompt per line, as a customer would ask, e.g. best project management tool for small teams", "每行一个提示词，按客户的问法写，例如：适合小团队的项目管理工具有哪些")} value={newPrompts} onChange={e => setNewPrompts(e.target.value)} />
        <div className="flex flex-col gap-2">
          <input className={`${INPUT} w-full md:w-40`} placeholder={t("Tag (optional)", "标签（可选）")} maxLength={40} value={newTag} onChange={e => setNewTag(e.target.value)} />
          <button type="button" className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" disabled={busy !== null || !newPrompts.trim()} onClick={() => void addPrompts()}><Plus size={14} />{t("Add", "添加")}</button>
        </div>
      </div>
      {workspace.prompts.length > 0 && <ul className="divide-y divide-border text-sm">{workspace.prompts.map(p => <li key={p.id} className="flex items-center gap-3 py-1.5">
        <input type="checkbox" checked={p.active} disabled={busy !== null} onChange={e => void togglePrompt(p.id, e.target.checked)} aria-label={t("Active", "启用")} />
        <span className={`flex-1 ${p.active ? "" : "text-muted-foreground line-through"}`}>{p.text}</span>
        {p.tag && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{p.tag}</span>}
        <button type="button" className="rounded p-1 text-muted-foreground hover:text-danger" aria-label={t("Delete", "删除")} disabled={busy !== null} onClick={() => deletePrompt(p.id)}><Trash2 size={14} /></button>
      </li>)}</ul>}
    </div>

    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <strong>{t("{n} tasks", "{n} 个任务", { n: workspace.estimate.tasks })}</strong>
          <span className="text-muted-foreground"> · {t("about {usd}, stops at the budget of {budget}", "约 {usd}，到达预算 {budget} 即停止", { usd: usd(workspace.estimate.usd), budget: usd(saved?.budgetUsd ?? 0) })}</span>
          {settingsChanged && <div className="text-xs text-warning">{t("Save the settings first: the run uses the saved platforms.", "请先保存设置：运行使用已保存的平台。")}</div>}
          {!workspace.runs.length && workspace.trialEstimate.tasks > 0 && <div className="text-xs text-muted-foreground">{t("First time? Start with a trial run: only the first active prompt on each platform, about {usd}.", "第一次使用？建议先试运行：每个平台只问第一个启用的提示词，约 {usd}。", { usd: usd(workspace.trialEstimate.usd) })}</div>}
        </div>
        {!confirming && <div className="flex flex-wrap gap-2">
          {!workspace.active && <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy !== null || !workspace.credentials || !saved || !workspace.trialEstimate.tasks || settingsChanged}
            title={t("{n} tasks, about {usd}", "{n} 个任务，约 {usd}", { n: workspace.trialEstimate.tasks, usd: usd(workspace.trialEstimate.usd) })}
            onClick={() => setConfirming("trial")}>{t("Trial run", "试运行")}</button>}
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
            disabled={busy !== null || !!workspace.active || !workspace.credentials || !saved || !workspace.estimate.tasks || settingsChanged}
            onClick={() => setConfirming("full")}><Play size={14} />{workspace.active
              ? (workspace.active.status === "QUEUED" ? t("Queued…", "排队中…") : workspace.active.trial ? t("Trial running…", "试运行中…") : t("Running…", "运行中…"))
              : t("Run now", "立即运行")}</button>
        </div>}
      </div>
      {confirming && <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
        {confirming === "trial"
          ? <p>{t("This asks {platforms} only the first active prompt, “{prompt}”: {tasks} paid DataForSEO tasks, about {usd}. Use it to check the setup and what a task really costs before a full run.", "将只向 {platforms} 提出第一个启用的提示词“{prompt}”：共 {tasks} 个 DataForSEO 付费任务，约 {usd}。用它在完整运行前检查设置和每个任务的实际花费。", { platforms: (saved?.platforms ?? []).map(id => platformName(id, locale)).join(", "), prompt: activePrompts[0]?.text ?? "", tasks: workspace.trialEstimate.tasks, usd: usd(workspace.trialEstimate.usd) })}</p>
          : <p>{t("This asks {platforms} each active prompt: {tasks} paid DataForSEO tasks, about {usd}. The run stops before it would pass {budget}.", "将向 {platforms} 提出每个启用的提示词：共 {tasks} 个 DataForSEO 付费任务，约 {usd}。运行在超过 {budget} 之前停止。", { platforms: (saved?.platforms ?? []).map(id => platformName(id, locale)).join(", "), tasks: workspace.estimate.tasks, usd: usd(workspace.estimate.usd), budget: usd(saved?.budgetUsd ?? 0) })}</p>}
        <div className="flex gap-2">
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy !== null} onClick={() => void startRun(confirming)}>{busy === "run" ? t("Starting…", "启动中…") : confirming === "trial" ? t("Confirm and run the trial", "确认并试运行") : t("Confirm and run", "确认并运行")}</button>
          <button type="button" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted" onClick={() => setConfirming(null)}>{t("Cancel", "取消")}</button>
        </div>
      </div>}
      {running && <p className="text-sm">{t("Running: {done} of {planned} tasks, {cost} so far.", "运行中：已完成 {done}/{planned} 个任务，目前花费 {cost}。", { done: running.done, planned: running.planned, cost: usd(running.costUsd) })}</p>}
    </div>

    {(columns.length > 0 && activePrompts.length > 0) && <div className="space-y-3">
      <h3 className="font-medium">{t("Latest answers", "最新回答")} <span className="text-xs font-normal text-muted-foreground">{t("newest answer per prompt and platform, last 90 days", "每个提示词在每个平台的最新回答，近 90 天")}</span></h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{columns.filter(id => workspace.latest.platforms[id]).map(id => {
        const v = workspace.latest.platforms[id]!;
        return <div key={id} className="rounded-lg border border-border p-3 text-sm">
          <div className="font-medium">{platformName(id, locale)}</div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-lg font-semibold">{percent(v.mentionRate)}</div><div className="text-xs text-muted-foreground">{t("named", "提及率")}</div></div>
            <div><div className="text-lg font-semibold">{percent(v.citationRate)}</div><div className="text-xs text-muted-foreground">{t("cited", "引用率")}</div></div>
            <div><div className="text-lg font-semibold">{percent(v.shareOfVoice)}</div><div className="text-xs text-muted-foreground">{t("share of voice", "声量份额")}</div></div>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{t("{n} answers", "{n} 个回答", { n: v.answers })}{v.noAnswer ? " · " + t("{n} without AI answer", "{n} 个无 AI 回答", { n: v.noAnswer }) : ""}{v.failed ? " · " + t("{n} failed", "{n} 个失败", { n: v.failed }) : ""}{v.avgCitationRank !== null ? " · " + t("avg. source #{n}", "平均第 {n} 个来源", { n: v.avgCitationRank.toFixed(1) }) : ""}</div>
        </div>;
      })}</div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
            <th className="px-3 py-2 font-medium">{t("Prompt", "提示词")}</th>
            {columns.map(id => <th key={id} className="px-2 py-2 text-center font-medium">{platformName(id, locale)}</th>)}
          </tr></thead>
          <tbody>{activePrompts.map(p => <tr key={p.id} className="border-t border-border">
            <td className="max-w-[360px] px-3 py-1.5">{p.text}</td>
            {columns.map(id => {
              const cell = cells.get(`${p.id}\0${id}`);
              const m = mark(cell, t);
              return <td key={id} className="px-2 py-1.5 text-center">
                {cell
                  ? <button type="button" className="inline-flex size-6 items-center justify-center rounded hover:bg-muted" title={m.title} aria-label={m.title} onClick={() => setOpenAnswer(cell.answerId)}><MarkIcon kind={m.kind} /></button>
                  : <span title={m.title}><MarkIcon kind="NONE" /><span className="sr-only">{m.title}</span></span>}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(["CITED", "NAMED", "NOT_NAMED", "NO_ANSWER", "FAILED"] as Mark[]).map(kind => <span key={kind} className="inline-flex items-center gap-1.5"><MarkIcon kind={kind} />{{
          CITED: t("cited", "被引用"), NAMED: t("named, not cited", "提及未引用"), NOT_NAMED: t("not named", "未提及"), NO_ANSWER: t("no AI answer", "无 AI 回答"), FAILED: t("failed", "失败"), NONE: "",
        }[kind]}</span>)}
      </p>
    </div>}

    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">{t("Record an answer by hand", "手动记录回答")}</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{t("Ask the prompt in the platform's app (signed out, or in a fresh chat), then paste the answer and the source links it showed.", "在平台的应用中提问（最好未登录或新开对话），再粘贴回答和其显示的来源链接。")}</p>
        <div className="grid gap-2 md:grid-cols-3">
          <select className={INPUT} value={manual.promptId} onChange={e => setManual({ ...manual, promptId: e.target.value })}>
            <option value="">{t("Choose a prompt", "选择提示词")}</option>
            {activePrompts.map(p => <option key={p.id} value={p.id}>{p.text.slice(0, 80)}</option>)}
          </select>
          <select className={INPUT} value={manual.platform} onChange={e => setManual({ ...manual, platform: e.target.value })}>
            {GEO_PLATFORMS.map(p => <option key={p.id} value={p.id}>{platformName(p.id, locale)}</option>)}
          </select>
          <select className={INPUT} value={manual.status} onChange={e => setManual({ ...manual, status: e.target.value as "OK" | "NO_ANSWER" })}>
            <option value="OK">{t("It answered", "有回答")}</option>
            <option value="NO_ANSWER">{t("No AI answer shown", "未显示 AI 回答")}</option>
          </select>
        </div>
        {manual.status === "OK" && <>
          <textarea className={`${INPUT} min-h-28 w-full`} placeholder={t("Paste the answer", "粘贴回答内容")} value={manual.text} onChange={e => setManual({ ...manual, text: e.target.value })} />
          <textarea className={`${INPUT} min-h-16 w-full font-mono text-xs`} placeholder={t("Source links, one per line", "来源链接，每行一个")} value={manual.citations} onChange={e => setManual({ ...manual, citations: e.target.value })} />
        </>}
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" disabled={busy !== null || !manual.promptId || (manual.status === "OK" && !manual.text.trim())} onClick={() => void saveManual()}>{busy === "manual" ? t("Saving…", "保存中…") : t("Save answer", "保存回答")}</button>
      </div>
    </details>

    {workspace.runs.length > 0 && <div className="space-y-2">
      <h3 className="font-medium">{t("Runs", "运行记录")}</h3>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
            <th className="px-3 py-2 font-medium">{t("Started", "开始时间")}</th>
            <th className="px-3 py-2 font-medium">{t("Status", "状态")}</th>
            <th className="px-3 py-2 font-medium">{t("Tasks", "任务")}</th>
            <th className="px-3 py-2 font-medium">{t("Cost", "花费")}</th>
            <th className="px-3 py-2 font-medium">{t("Named / cited by platform", "各平台提及 / 引用")}</th>
          </tr></thead>
          <tbody>{workspace.runs.map(run => <tr key={run.id} className="border-t border-border align-top">
            <td className="px-3 py-1.5 whitespace-nowrap">{new Date(run.startedAt).toLocaleString()}<div className="text-xs text-muted-foreground">{run.source === "schedule" ? t("scheduled", "定期") : t("by hand", "手动")}{run.trial && <> · {t("trial", "试运行")}</>}</div></td>
            <td className="px-3 py-1.5">{runStatus(run, t)}{runError(run, t) && <div className="text-xs text-muted-foreground">{runError(run, t)}</div>}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">{run.done - run.failed}/{run.planned}{run.failed ? <span className="text-danger"> · {t("{n} failed", "{n} 失败", { n: run.failed })}</span> : null}</td>
            <td className="px-3 py-1.5">{usd(run.costUsd)}</td>
            <td className="px-3 py-1.5 text-xs">{run.summary ? Object.entries(run.summary).map(([id, v]) => <div key={id}>{platformName(id, locale)}: {percent(v?.mentionRate ?? null)} / {percent(v?.citationRate ?? null)}</div>) : "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>}

    {openAnswer && <AnswerPanel siteId={siteId} answerId={openAnswer} onClose={() => setOpenAnswer(null)} onDeleted={next => apply(next, false)} />}
  </section>;
}
