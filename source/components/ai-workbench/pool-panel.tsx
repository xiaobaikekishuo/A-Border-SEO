"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Gauge, Loader2, Play, RefreshCw, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { AutomationView, PoolView } from "@/lib/ai-workbench/pool/view";
import type { FillerPreview } from "@/lib/ai-workbench/pool/fill";
import type { LimitWindow } from "@/lib/ai-workbench/pool/limits";
import { resultHref, toolAnchor } from "@/lib/ai-workbench/job-link";
import { RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import { OutputLanguageOptions } from "./output-language";
import { CAP_CHOICES, FILLERS, fillerText, itemStatus, previewText, queuedText, sourceLabel, statusText, type Filler } from "./pool-text";
import k from "@/components/research/keyword-ai-panel.module.css";
import s from "./tool-panel.module.css";

/*
 * The background task pool on the Codex workbench page: the local Codex's
 * allowance and what it allows now, the owner's reserves and per-task models,
 * what fills this site's pool (with what each filler would find now and found
 * last time), work queued by hand and the items with links to their results.
 */

type Settings = PoolView["settings"];
type Effort = NonNullable<Settings["routing"]["light"]["reasoning"]>;
type When = (iso: string) => string;
type Act = (payload: Record<string, unknown>, key: string) => Promise<boolean>;
const EFFORTS: Effort[] = ["minimal", "low", "medium", "high", "xhigh"];
const TONES = { "": "", warn: s.warn, good: s.good, bad: s.bad } as const;

function effortLabel(effort: Effort, t: Translator) {
  return {
    minimal: t("Minimal", "最少"),
    low: t("Low", "低"),
    medium: t("Medium", "中"),
    high: t("High", "高"),
    xhigh: t("Very high", "很高"),
  }[effort];
}
const spin = (on: boolean, Icon: typeof Play) => (on ? <Loader2 className="animate-spin" size={14} /> : <Icon size={14} />);

function Meter({
  label,
  window,
  stopAt,
  t,
  when,
}: {
  label: string;
  window: LimitWindow | null;
  stopAt: number;
  t: Translator;
  when: When;
}) {
  if (!window)
    return (
      <div className={s.meter}>
        <span className={k.muted}>{label}</span>
        <span className={k.muted}>{t("No such window on this plan", "这个套餐没有这个窗口")}</span>
      </div>
    );
  const used = Math.round(window.usedPercent);
  return (
    <div className={s.meter}>
      <span className={k.muted}>{label}</span>
      <strong>{t(`${used}% used`, `已用 ${used}%`)}</strong>
      <span className={s.bar} role="img" aria-label={t(`${used}% used`, `已用 ${used}%`)}>
        <span
          className={`${s.barFill} ${window.usedPercent >= stopAt ? s.barReserve : ""}`}
          style={{ width: `${Math.min(100, window.usedPercent)}%` }}
        />
      </span>
      <span className={k.muted}>
        {t(`Background tasks stop at ${stopAt}%`, `后台任务在 ${stopAt}% 停`)}
        {window.resetsAt ? ` · ${t("resets", "重置")} ${when(new Date(window.resetsAt * 1000).toISOString())}` : ""}
      </span>
    </div>
  );
}

/** initialView: a view to show before the first load (tests); it may carry a preview. */
export function PoolPanel({ siteId, initialView = null }: { siteId: string; initialView?: PoolView | null }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<PoolView | null>(initialView);
  const [settings, setSettings] = useState<Settings | null>(initialView?.settings ?? null);
  const [automation, setAutomation] = useState<AutomationView | null>(initialView?.automation ?? null);
  const [preview, setPreview] = useState<FillerPreview | null>(initialView?.preview ?? null);
  const [hidden, setHidden] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant/pool`;
  const when = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  const load = useCallback(
    async (signal?: AbortSignal, withPreview = false) => {
      const response = await fetch(withPreview ? `${endpoint}?preview=1` : endpoint, { cache: "no-store", signal });
      // An install or plan without the Codex workbench has nothing to show here.
      if (response.status === 403 || response.status === 404) {
        setHidden(true);
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setView(body as PoolView);
      if ((body as PoolView).preview) setPreview((body as PoolView).preview!);
      // Unsaved edits stay; the drafts start from the first view.
      setSettings(current => current ?? (body as PoolView).settings);
      setAutomation(current => current ?? (body as PoolView).automation);
    },
    [endpoint],
  );
  const loadFailed = useCallback(() => setError(t("Could not load the background task pool.", "无法读取后台任务池。")), [t]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      load(controller.signal).catch(reason => {
        if (!controller.signal.aborted && reason?.name !== "AbortError") loadFailed();
      });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [load, loadFailed]);
  /** What each filler would find now: loaded when the fillers or batch work are first opened. */
  function openPreview(open: boolean) {
    if (open && !preview) void load(undefined, true).catch(loadFailed);
  }

  async function send(method: "PUT" | "POST", payload: unknown, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      return body as Record<string, unknown>;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      setError(
        (
          {
            "Only waiting items can be canceled": t("Only waiting items can be canceled.", "只能取消等待中的项。"),
            "Run a crawl first": t("Run a crawl first.", "请先完成一次抓取。"),
            "No finished rank check yet": t("No rank check has finished yet.", "还没有完成的排名检查。"),
          } as Record<string, string>
        )[message] ?? t("That did not work. Try again.", "操作没有成功，请重试。"),
      );
      return null;
    } finally {
      setBusy(null);
    }
  }
  async function save(part: "settings" | "automation") {
    const body = (await send("PUT", part === "settings" ? { settings } : { automation }, part)) as PoolView | null;
    if (!body) return false;
    setView(body);
    if (part === "settings") setSettings(body.settings);
    else setAutomation(body.automation);
    setNotice(t("Saved.", "已保存。"));
    return true;
  }
  const act: Act = async (payload, key) => {
    const body = await send("POST", payload, key);
    if (!body) return false;
    const action = String(payload.action);
    if (action !== "cancel" && action !== "reviewed" && action !== "reviewedAll") setNotice(queuedText(action, body, t));
    await load(undefined, !!preview).catch(() => {});
    return true;
  };
  /** Checks with the fillers as saved: unsaved changes are saved first. */
  async function checkNow() {
    if (JSON.stringify(automation) !== JSON.stringify(view?.automation) && !(await save("automation"))) return;
    await act({ action: "fillNow" }, "fillNow");
  }

  if (hidden) return null;
  const header = (
    <div className={k.header}>
      <div>
        <h3 className="flex items-center gap-2">
          <Gauge size={18} />
          {t("Background task pool", "后台任务池")}
        </h3>
        <p className={k.muted}>
          {t(
            "When your local Codex is idle, it uses allowance that would otherwise expire on the work below. Results are drafts only; nothing is changed on your site.",
            "本机 Codex 空闲时，用本来会过期作废的额度做下面这些事。结果只出草稿，不改网站。",
          )}
        </p>
      </div>
      <button
        type="button"
        className={k.secondary}
        disabled={!!busy}
        onClick={() => {
          void load(undefined, !!preview).catch(loadFailed);
        }}
      >
        <RefreshCw size={14} />
        {t("Refresh", "刷新")}
      </button>
    </div>
  );
  if (!view || !settings || !automation) {
    return (
      <section className={k.card}>
        {header}
        {error ? (
          <p className={k.error}>{error}</p>
        ) : (
          <p className={k.status}>
            <Loader2 className="animate-spin" size={16} />
            {t("Loading", "正在读取")}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className={k.card}>
      {header}
      {error && (
        <p className={`${k.error} mt-3`} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={`${k.notice} mt-3`} role="status">
          {notice}
        </p>
      )}
      <PoolState view={view} t={t} when={when} />
      <SettingsEditor view={view} settings={settings} setSettings={setSettings} busy={busy} save={() => void save("settings")} t={t} />
      <details className={s.section} onToggle={event => openPreview((event.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer font-semibold">{t("What fills this site's pool", "本站自动加任务")}</summary>
        <FillerRows
          view={view}
          automation={automation}
          setAutomation={setAutomation}
          preview={preview}
          busy={busy}
          act={act}
          t={t}
          when={when}
        />
        <div className={`${s.toolbar} mt-4`}>
          <div>
            <button type="button" className={k.save} disabled={!!busy} onClick={() => void save("automation")}>
              {spin(busy === "automation", Check)}
              {t("Save", "保存")}
            </button>
            <button type="button" className={k.secondary} disabled={!!busy} onClick={() => void checkNow()}>
              {spin(busy === "fillNow", Search)}
              {t("Check now", "现在检查一次")}
            </button>
          </div>
        </div>
      </details>
      <details
        className={s.section}
        onToggle={event => {
          const open = (event.currentTarget as HTMLDetailsElement).open;
          openPreview(open);
          if (open) setBatchOpen(true);
        }}
      >
        <summary className="cursor-pointer font-semibold">{t("Batch work", "批量任务")}</summary>
        <BatchWork siteId={siteId} open={batchOpen} view={view} preview={preview} busy={busy} act={act} t={t} locale={locale} />
      </details>
      <ItemList siteId={siteId} view={view} busy={busy} act={act} t={t} when={when} />
    </section>
  );
}

/** Whether the pool runs now and why not, the allowance meters and the counts. */
function PoolState({ view, t, when }: { view: PoolView; t: Translator; when: When }) {
  const { reading, policy } = view;
  const policyText = policy.ok
    ? t("Running: the worker takes the next item whenever it is idle.", "运行中：worker 空闲时会领取下一项。")
    : (
        {
          server_off: t(
            "Background tasks are turned off on this server (AI_POOL_ENABLED=false).",
            "这台服务器关闭了后台任务（AI_POOL_ENABLED=false）。",
          ),
          pool_off: t("The pool is off. Turn it on under Settings.", "任务池未开启，可在下面的设置里打开。"),
          no_reading: t(
            "No allowance reading from your local Codex yet. It needs the 1.9.0 desktop client or local worker.",
            "还没有收到本机 Codex 的额度读数。需要 1.9.0 以上的桌面客户端或本机 worker。",
          ),
          stale_reading: t(
            "The last allowance reading is more than 15 minutes old. Is the desktop client running?",
            "最近一次额度读数已超过 15 分钟，请确认桌面客户端在运行。",
          ),
          limit_reached: t("A usage limit was reached.", "已达到用量上限。"),
          short_window: t(
            `The 5-hour window reached ${100 - view.settings.shortReserve}%; the rest is kept for tasks you start.`,
            `5 小时窗口已用到 ${100 - view.settings.shortReserve}%，剩下的留给你手动发起的任务。`,
          ),
          weekly_reserve: t(
            `This week's allowance reached ${100 - view.settings.weeklyReserve}%, the most background tasks may use.`,
            `本周额度已用到 ${100 - view.settings.weeklyReserve}%，这是后台任务能用的上限。`,
          ),
          weekly_pace: t("This week's allowance is being used faster than the week goes by.", "本周额度用得比时间过得快。"),
          review_cap: t(
            `Results waiting for review: ${view.counts.waitingReview}. Mark what you have read to continue.`,
            `已有 ${view.counts.waitingReview} 份结果待审阅，看完标记后继续。`,
          ),
        } as Record<string, string>
      )[policy.reason] + (policy.resumeAt ? ` ${t("Resumes about", "预计恢复")} ${when(policy.resumeAt)}` : "");
  const readingError = reading?.error
    ? ((
        {
          login_required: t("Codex is not signed in to ChatGPT.", "Codex 没有登录 ChatGPT。"),
          unsupported: t("This Codex version cannot report its allowance. Update Codex.", "这个版本的 Codex 不能读取额度，请更新 Codex。"),
          codex_unavailable: t("Codex could not be started.", "无法启动 Codex。"),
        } as Record<string, string>
      )[reading.error] ?? t("Reading the allowance failed; it is tried again in a few minutes.", "读取额度失败，几分钟后会再试。"))
    : "";
  const running = view.items.filter(
    item => item.status === "STARTED" && (item.jobStatus === "QUEUED" || item.jobStatus === "RUNNING"),
  ).length;
  return (
    <>
      <p className={`${k.notice} mt-4`}>{policyText}</p>
      {reading?.limits ? (
        <div className={s.meters}>
          <Meter
            label={t("5-hour window", "5 小时窗口")}
            window={reading.short}
            stopAt={100 - view.settings.shortReserve}
            t={t}
            when={when}
          />
          <Meter
            label={t("Weekly allowance", "每周额度")}
            window={reading.long}
            stopAt={100 - view.settings.weeklyReserve}
            t={t}
            when={when}
          />
        </div>
      ) : (
        <p className={`${k.muted} mt-3`}>{readingError || t("No reading yet.", "还没有读数。")}</p>
      )}
      {reading?.readAt && (
        <p className={`${k.muted} mt-2`}>
          {t("Read", "读取于")} {when(reading.readAt)}
          {reading.limits?.planType ? ` · ${t("plan", "套餐")} ${reading.limits.planType}` : ""}
          {reading.stale ? ` · ${t("out of date", "已过期")}` : ""}
        </p>
      )}
      {reading?.limits?.hasCredits && (
        <p className={`${k.muted} mt-2`}>
          {t(
            "This account has a credit balance. Background tasks stop at your limits and never start on credits; turning off auto top-up in ChatGPT is a second safeguard.",
            "这个账号有 credits 余额。后台任务在你设的上限前停手，不会在超出套餐后开始；在 ChatGPT 里关掉自动充值可以再加一道保险。",
          )}
        </p>
      )}
      <div className={s.facts}>
        <div>
          <dt>{t("Waiting", "等待中")}</dt>
          <dd>{view.counts.pending}</dd>
        </div>
        <div>
          <dt>{t("Running", "运行中")}</dt>
          <dd>{running}</dd>
        </div>
        <div>
          <dt>{t("Waiting for review", "待审阅")}</dt>
          <dd>
            {view.counts.waitingReview} / {view.settings.reviewCap}
          </dd>
        </div>
        <div>
          <dt>{t("Started automatically today on this site", "本站今天自动开始")}</dt>
          <dd>{view.counts.startedToday}</dd>
        </div>
      </div>
    </>
  );
}

/** The owner's reserves, review cap, result language and per-task models. */
function SettingsEditor({
  view,
  settings,
  setSettings,
  busy,
  save,
  t,
}: {
  view: PoolView;
  settings: Settings;
  setSettings: (next: Settings) => void;
  busy: string | null;
  save: () => void;
  t: Translator;
}) {
  const reading = view.reading;
  const modelOptions = (selected: string | null) => {
    const models = reading?.models ?? [];
    const extra = selected && !models.some(model => model.id === selected) ? [{ id: selected, name: selected }] : [];
    return [...models, ...extra];
  };
  const effortsFor = (model: string | null) => {
    const models = reading?.models ?? [];
    const target = model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
    return target?.efforts.length ? EFFORTS.filter(effort => target.efforts.includes(effort)) : EFFORTS;
  };
  const tierEditor = (tier: "light" | "main", label: string, hint: string) => {
    const value = settings.routing[tier];
    const setTier = (next: Partial<typeof value>) =>
      setSettings({ ...settings, routing: { ...settings.routing, [tier]: { ...value, ...next } } });
    return (
      <div className={k.field}>
        <span>{label}</span>
        <span className={k.muted}>{hint}</span>
        <div className={k.pair}>
          <select
            aria-label={t(`${label}: model`, `${label}：模型`)}
            value={value.model ?? ""}
            onChange={event => setTier({ model: event.target.value || null })}
          >
            <option value="">{t("Codex default model", "跟随 Codex 默认模型")}</option>
            {modelOptions(value.model).map(model => (
              <option key={model.id} value={model.id}>
                {model.name === model.id ? model.id : `${model.name} (${model.id})`}
              </option>
            ))}
          </select>
          <select
            aria-label={t(`${label}: reasoning effort`, `${label}：推理强度`)}
            value={value.reasoning ?? ""}
            onChange={event => setTier({ reasoning: (event.target.value || null) as Effort | null })}
          >
            <option value="">{t("Worker's own setting", "跟随本机 worker 设置")}</option>
            {effortsFor(value.model).map(effort => (
              <option key={effort} value={effort}>
                {t("Reasoning", "推理")}：{effortLabel(effort, t)}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  };
  const choice = (key: "shortReserve" | "weeklyReserve" | "reviewCap", values: number[], suffix: string) => (
    <select value={settings[key]} onChange={event => setSettings({ ...settings, [key]: Number(event.target.value) })}>
      {values.map(value => (
        <option key={value} value={value}>
          {value}
          {suffix}
        </option>
      ))}
    </select>
  );
  return (
    <details className={s.section}>
      <summary className="cursor-pointer font-semibold">{t("Settings", "设置")}</summary>
      <div className={k.fields}>
        <label className={s.switch}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={event => setSettings({ ...settings, enabled: event.target.checked })}
          />
          {t("Run background tasks", "开启后台任务池")}
        </label>
        <div className={k.pair}>
          <label className={k.field}>
            <span>{t("Keep of the 5-hour window for your own tasks", "5 小时窗口留给手动任务")}</span>
            {choice("shortReserve", [10, 20, 30, 40, 50], "%")}
          </label>
          <label className={k.field}>
            <span>{t("Never use of the weekly allowance", "每周额度至少保留")}</span>
            {choice("weeklyReserve", [5, 10, 15, 20, 30], "%")}
          </label>
        </div>
        <div className={k.pair}>
          <label className={k.field}>
            <span>{t("Pause when this many results wait for review", "待审阅结果达到这个数就暂停")}</span>
            {choice("reviewCap", [10, 20, 30, 50], "")}
          </label>
          <label className={k.field}>
            <span>{t("Language of background results", "后台结果的语言")}</span>
            <select value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value })}>
              <OutputLanguageOptions />
            </select>
          </label>
        </div>
        {tierEditor(
          "light",
          t("Fixed-format tasks", "格式固定的任务"),
          t(
            "Titles, emails, clusters, structured data, briefs, keyword ideas: a lighter model gets many more of them out of the same allowance.",
            "标题、邮件、聚类、结构化数据、简报、关键词：轻量模型用同样的额度能跑多得多。",
          ),
        )}
        {tierEditor(
          "main",
          t("Writing and analysis", "写作和分析"),
          t("Articles, localization, fix plans, reports and analyses.", "文章、本地化、修复方案、报表和分析。"),
        )}
        {!reading?.routing && (
          <p className={k.muted}>
            {t(
              "Per-task models need the 1.9.0 desktop client or local worker; older ones keep their own model and reasoning effort.",
              "按任务分配模型需要 1.9.0 以上的桌面客户端或本机 worker；旧版本继续用自己的模型和推理强度。",
            )}
          </p>
        )}
        <div>
          <button type="button" className={k.save} disabled={!!busy} onClick={save}>
            {spin(busy === "settings", Check)}
            {t("Save settings", "保存设置")}
          </button>
        </div>
      </div>
    </details>
  );
}

/** One row per filler: the switch, what it would find now, what it found last time, its daily limit and today's count. */
function FillerRows({
  view,
  automation,
  setAutomation,
  preview,
  busy,
  act,
  t,
  when,
}: {
  view: PoolView;
  automation: AutomationView;
  setAutomation: (next: AutomationView) => void;
  preview: FillerPreview | null;
  busy: string | null;
  act: Act;
  t: Translator;
  when: When;
}) {
  const setCap = (filler: Filler, value: number) => setAutomation({ ...automation, caps: { ...automation.caps, [filler]: value } });
  return (
    <>
      <p className={`${k.muted} mt-3`}>
        {view.settings.enabled
          ? t(
              "Each filler queues work when it finds something new. Ranking reviews and alert diagnoses start with what happens after you turn them on.",
              "每一项发现新情况时才加任务。排名复盘和提醒诊断从开启以后发生的变化算起。",
            )
          : t(
              "The pool is off, so nothing is checked by itself. You can still check now; queued work waits until the pool is on.",
              "任务池没开，不会自动检查；可以点“现在检查一次”，加进来的任务等任务池打开后再跑。",
            )}
      </p>
      <div className={s.fillers}>
        {FILLERS.map(filler => {
          const [title, detail] = fillerText(filler, t);
          const choices = [...new Set([...CAP_CHOICES[filler], automation.caps[filler]])].sort((a, b) => a - b);
          return (
            <div key={filler} className={s.filler}>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={automation[filler]}
                  onChange={event => setAutomation({ ...automation, [filler]: event.target.checked })}
                />
                <span>
                  <strong>{title}</strong>
                  <br />
                  <span className={k.muted}>{detail}</span>
                </span>
              </label>
              {preview && (
                <p className={s.fillerLine}>
                  {t("Now", "现在")}：{previewText(filler, preview, view.automation.alertsScope, t, when)}
                </p>
              )}
              {view.automation[filler] && <p className={s.fillerLine}>{statusText(filler, view.fillers.status[filler], t, when)}</p>}
              <div className={s.fillerMeta}>
                <label className={s.inline}>
                  {t("Per day at most", "每天最多")}
                  <select
                    className={s.badge}
                    value={automation.caps[filler]}
                    onChange={event => setCap(filler, Number(event.target.value))}
                  >
                    {choices.map(value => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <span className={k.muted}>
                  {t(`Started today: ${view.fillers.startedToday[filler]}`, `今天已开始 ${view.fillers.startedToday[filler]} 项`)}
                </span>
                {filler === "alerts" && (
                  <label className={s.inline}>
                    {t("Which alerts", "哪些提醒")}
                    <select
                      className={s.badge}
                      value={automation.alertsScope}
                      onChange={event => setAutomation({ ...automation, alertsScope: event.target.value === "all" ? "all" : "drops" })}
                    >
                      <option value="drops">{t("Traffic and ranking drops", "流量和排名下降")}</option>
                      <option value="all">{t("Any alert", "任何提醒")}</option>
                    </select>
                  </label>
                )}
                {filler === "rankings" && (
                  <button
                    type="button"
                    className={s.copy}
                    disabled={!!busy}
                    onClick={() => void act({ action: "reviewLatestRun" }, "reviewLatestRun")}
                  >
                    {spin(busy === "reviewLatestRun", Play)}
                    {t("Review the latest check now", "现在复盘最近一次检查")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Work queued by hand: structured data, titles, briefs and localization; outreach is queued from its own panel. */
function BatchWork({
  siteId,
  open,
  view,
  preview,
  busy,
  act,
  t,
  locale,
}: {
  siteId: string;
  open: boolean;
  view: PoolView;
  preview: FillerPreview | null;
  busy: string | null;
  act: Act;
  t: Translator;
  locale: string;
}) {
  const [pages, setPages] = useState<{ id: string; url: string; title: string | null; hasBody: boolean }[] | null>(null);
  const [pageError, setPageError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [language, setLanguage] = useState("en");
  const [location, setLocation] = useState(2840);
  // The crawled pages for localization, loaded when batch work is first opened.
  useEffect(() => {
    if (!open || pages) return;
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant`, { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error();
        if (alive) setPages((body.pages ?? []).filter((page: { hasBody: boolean }) => page.hasBody));
      })
      .catch(() => {
        if (alive) setPageError(t("Could not load the crawled pages.", "无法读取已抓取的页面。"));
      });
    return () => {
      alive = false;
    };
  }, [open, pages, siteId, t]);
  const button = (action: string, label: string, disabled = false) => (
    <button type="button" className={`${k.secondary} mt-2`} disabled={!!busy || disabled} onClick={() => void act({ action }, action)}>
      {spin(busy === action, Play)}
      {label}
    </button>
  );
  return (
    <div className={k.fields}>
      <div>
        <p className={k.muted}>
          {t(
            `${view.missingSchema} indexable pages of the latest crawl have no structured data. Queue one task per page, new pages first, up to 50.`,
            `最近一次抓取里有 ${view.missingSchema} 个可索引页面没有结构化数据，每页一个任务，新页面优先，最多 50 个。`,
          )}
        </p>
        {button("batchSchema", t("Queue structured data for these pages", "为这些页面排队生成结构化数据"), !view.missingSchema)}
      </div>
      <div>
        <p className={k.muted}>
          {t(
            "Titles and descriptions of every low-CTR page not rewritten in the last 28 days, 20 pages to a task.",
            "把近 28 天没改写过的低点击率页面都排上，改写标题和描述，每 20 页一项。",
          )}
          {preview?.meta ? ` ${t(`${preview.meta.pages} pages now.`, `现在有 ${preview.meta.pages} 个。`)}` : ""}
        </p>
        {button("batchMeta", t("Queue title rewrites", "排队改写标题和描述"), preview?.meta?.pages === 0)}
      </div>
      <div>
        <p className={k.muted}>
          {t(
            "A brief for every planned topic without one, one task per topic, up to 30 at a time.",
            "给所有没有简报的待写选题排上简报，每个选题一项，一次最多 30 个。",
          )}
          {preview?.briefs ? ` ${t(`${preview.briefs.open} not queued yet.`, `现在有 ${preview.briefs.open} 个还没排过。`)}` : ""}
        </p>
        {button("batchBriefs", t("Queue topic briefs", "排队生成选题简报"), preview?.briefs?.open === 0)}
      </div>
      <p className={k.muted}>
        {t(
          "Outreach drafts for all prospects of a Manus link task are queued from the outreach panel on the Backlinks page.",
          "外链联络邮件：在“外链”页的联络邮件面板里，可以把一个 Manus 任务的全部机会整批排进来。",
        )}{" "}
        <Link href={`/sites/${encodeURIComponent(siteId)}/backlinks#${toolAnchor("OUTREACH_EMAILS")}`}>{t("Open it", "去排")}</Link>
      </p>
      <div>
        <p className={k.muted}>
          {t(
            "Localize crawled articles for a market: pick up to 20 pages with body text.",
            "按目标市场批量本地化已抓取的文章：最多选 20 个有正文的页面。",
          )}
        </p>
        <div className={`${k.pair} mt-2`}>
          <label className={k.field}>
            <span>{t("Target language", "目标语言")}</span>
            <select value={language} onChange={event => setLanguage(event.target.value)}>
              <OutputLanguageOptions />
            </select>
          </label>
          <label className={k.field}>
            <span>{t("Target country or region", "目标国家/地区")}</span>
            <select value={location} onChange={event => setLocation(Number(event.target.value))}>
              {RESEARCH_LOCATIONS.map(item => (
                <option key={item.value} value={item.value}>
                  {locale === "zh" ? item.zh : item.en}
                </option>
              ))}
            </select>
          </label>
        </div>
        {pageError ? (
          <p className={`${k.error} mt-2`}>{pageError}</p>
        ) : !pages ? (
          <p className={k.status}>
            <Loader2 className="animate-spin" size={16} />
            {t("Loading pages", "正在读取页面")}
          </p>
        ) : !pages.length ? (
          <p className={`${k.muted} mt-2`}>{t("No crawled page with body text yet.", "还没有带正文的已抓取页面。")}</p>
        ) : (
          <div className={`${s.picker} mt-2`}>
            {pages.map(page => (
              <label key={page.id} className={s.check}>
                <input
                  type="checkbox"
                  checked={picked.includes(page.id)}
                  disabled={!picked.includes(page.id) && picked.length >= 20}
                  onChange={event =>
                    setPicked(current => (event.target.checked ? [...current, page.id] : current.filter(id => id !== page.id)))
                  }
                />
                <span>
                  {page.title || page.url}
                  <br />
                  <span className={s.url}>{page.url}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`${k.secondary} mt-2`}
          disabled={!!busy || !picked.length}
          onClick={() =>
            void act({ action: "batchLocalize", pageIds: picked, language, location }, "batchLocalize").then(done => {
              if (done) setPicked([]);
            })
          }
        >
          {spin(busy === "batchLocalize", Play)}
          {t(`Queue ${picked.length} pages`, `排队 ${picked.length} 个页面`)}
        </button>
      </div>
    </div>
  );
}

/** The pool's items, newest work first, with links to each task's result. */
function ItemList({
  siteId,
  view,
  busy,
  act,
  t,
  when,
}: {
  siteId: string;
  view: PoolView;
  busy: string | null;
  act: Act;
  t: Translator;
  when: When;
}) {
  const shown = view.items.slice(0, 30);
  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <h4>{t("Items", "任务")}</h4>
        {view.counts.waitingReview > 0 && (
          <button
            type="button"
            className={k.secondary}
            disabled={!!busy}
            onClick={() => void act({ action: "reviewedAll" }, "reviewedAll")}
          >
            <Check size={14} />
            {t("Mark all results as reviewed", "全部标为已看过")}
          </button>
        )}
      </div>
      {!shown.length ? (
        <p className={k.muted}>
          {t(
            "Nothing in the pool yet. Turn on what fills it, or queue batch work.",
            "任务池还是空的。可以开启自动加任务，或排队批量任务。",
          )}
        </p>
      ) : (
        <div className={s.items}>
          {shown.map(item => {
            const status = itemStatus(item, t);
            const finished = item.status === "STARTED" && item.jobStatus === "SUCCEEDED";
            return (
              <div key={item.id} className={s.item}>
                <div>
                  <span className={s.badge}>{sourceLabel(item.source, t)}</span>
                  <span>{item.title}</span>
                </div>
                <div>
                  <span className={`${s.badge} ${TONES[status.tone]}`}>{status.text}</span>
                  <span className={k.muted}>{when(item.startedAt ?? item.createdAt)}</span>
                  {item.status === "PENDING" && (
                    <button
                      type="button"
                      className={s.copy}
                      disabled={!!busy}
                      onClick={() => void act({ action: "cancel", itemId: item.id }, `cancel:${item.id}`)}
                    >
                      <X size={13} />
                      {t("Cancel", "取消")}
                    </button>
                  )}
                  {item.jobId && item.status === "STARTED" && (
                    <Link className={s.copy} href={resultHref(siteId, item.kind, item.jobId)}>
                      {finished ? t("Open the result", "查看结果") : t("Open the task", "查看任务")}
                    </Link>
                  )}
                  {finished && !item.reviewedAt && (
                    <button
                      type="button"
                      className={s.copy}
                      disabled={!!busy}
                      onClick={() => void act({ action: "reviewed", itemId: item.id }, `reviewed:${item.id}`)}
                    >
                      <Check size={13} />
                      {t("Reviewed", "已看过")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
