"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { WeeklyReportView } from "@/lib/ai-workbench/weekly-settings";
import { resultHref } from "@/lib/ai-workbench/job-link";
import { OutputLanguageOptions } from "./output-language";
import k from "@/components/research/keyword-ai-panel.module.css";
import s from "./tool-panel.module.css";

/** The weekly AI action list switch of a site: written by the owner's local Codex, sent by alert email and webhook. */
export function WeeklyReportToggle({ siteId }: { siteId: string }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<WeeklyReportView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant/weekly-report`;
  useEffect(() => {
    let alive = true;
    fetch(endpoint, { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        // An install or plan without the Codex workbench has nothing to show here.
        if (response.status === 403 || response.status === 404) {
          if (alive) setHidden(true);
          return;
        }
        if (!response.ok) throw new Error();
        if (alive) setView(body as WeeklyReportView);
      })
      .catch(() => {
        if (alive) setError(t("Could not load the weekly AI action list setting.", "无法读取每周 AI 行动清单设置。"));
      });
    return () => {
      alive = false;
    };
  }, [endpoint, t]);
  async function save(next: { enabled: boolean; language: string }) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setView(body as WeeklyReportView);
    } catch {
      setError(t("The setting was not saved. Try again.", "设置没有保存，请重试。"));
    } finally {
      setSaving(false);
    }
  }
  if (hidden) return null;
  const date = (value: string) =>
    new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const job = view?.lastJob;
  const jobStatus = job
    ? ((
        {
          QUEUED: t("queued", "排队中"),
          RUNNING: t("being written", "生成中"),
          SUCCEEDED: t("ready", "已完成"),
          FAILED: t("not finished", "未完成"),
        } as Record<string, string>
      )[job.status] ?? job.status)
    : null;
  return (
    <section className={k.card} aria-label={t("Weekly AI action list", "每周 AI 行动清单")}>
      <div className={k.header}>
        <h3 className="flex items-center gap-2">
          <CalendarClock size={18} />
          {t("Weekly AI action list", "每周 AI 行动清单")}
        </h3>
        {saving && <Loader2 size={16} className={k.spinner} />}
      </div>
      <p className={k.muted}>
        {t(
          "From Monday 00:00 UTC each week, the first time your desktop app's local Codex asks for work it writes this week's action list with your ChatGPT allowance, then sends it to your alert email and webhook. While the desktop app is quit, it waits until the app runs again; closing the window is fine.",
          "每周一 0:00（UTC，即北京时间 8:00）之后，桌面客户端的本机 Codex 第一次领取任务时，用你的 ChatGPT 额度写本周行动清单，再发到提醒邮箱和 Webhook。桌面客户端退出时，会等到下次打开再写；只关窗口不影响。",
        )}
      </p>
      {error && <p className={`${k.error} mt-3`}>{error}</p>}
      {!view && !error && <p className={`${k.muted} mt-3`}>{t("Loading…", "正在读取…")}</p>}
      {view && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className={s.switch}>
              <input
                type="checkbox"
                checked={view.enabled}
                disabled={saving}
                onChange={event => void save({ enabled: event.target.checked, language: view.language })}
              />
              {t("Write it every week", "每周自动生成")}
            </label>
            <label className={`${s.switch} font-normal`}>
              {t("Language", "语言")}
              <select
                className={s.badge}
                value={view.language}
                disabled={saving}
                onChange={event => void save({ enabled: view.enabled, language: event.target.value })}
              >
                <OutputLanguageOptions />
              </select>
            </label>
          </div>
          {!view.scheduler && (
            <p className={`${k.error} mt-3`}>
              {t(
                "Scheduled work is off on this server (SCHEDULER_ENABLED or SCHEDULE_WEEKLY_AI_REPORT), so no list is written.",
                "这台服务器关闭了定时任务（SCHEDULER_ENABLED 或 SCHEDULE_WEEKLY_AI_REPORT），不会生成清单。",
              )}
            </p>
          )}
          <dl className={s.facts}>
            <div>
              <dt>{t("Next one due", "下一份")}</dt>
              <dd>
                {!view.enabled
                  ? t("Off", "未开启")
                  : view.dueNow
                    ? t("This week's: when your local Codex is next idle", "本周这份：本机 Codex 下次空闲时生成")
                    : date(view.nextDue)}
              </dd>
            </div>
            <div>
              <dt>{t("Sent to", "发送到")}</dt>
              <dd>
                {[view.delivery.email && t("alert email", "提醒邮箱"), view.delivery.webhook && "Webhook"]
                  .filter(Boolean)
                  .join(t(", ", "、")) || t("Nowhere yet: kept in the workbench", "暂未设置：只保存在工作台")}
              </dd>
            </div>
            <div>
              <dt>{t("Last one", "上一份")}</dt>
              <dd>
                {job ? (
                  <Link className="text-link" href={resultHref(siteId, "SEO_FIX_PLAN", job.id)}>
                    {date(job.createdAt)} · {jobStatus}
                  </Link>
                ) : (
                  t("None yet", "还没有")
                )}
              </dd>
            </div>
          </dl>
          <p className={`${k.muted} mt-3`}>
            {t(
              "Each list is one Codex task on your plan's allowance. Set the email and webhook in Settings.",
              "每份清单占用一次 Codex 任务额度。邮箱和 Webhook 在“设置”里配置。",
            )}
          </p>
        </>
      )}
    </section>
  );
}
