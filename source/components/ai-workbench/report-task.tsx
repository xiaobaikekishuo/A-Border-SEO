"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { reportTitle, type ActionScope, type ReportEvidence, type ReportSource } from "@/lib/ai-workbench/action-scope";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { WorkbenchResult } from "./model";
import s from "./workbench.module.css";

const reports = {
  gsc: ["Search Console", "Google 搜索表现", "pages"],
  bing: ["Bing", "Bing 报表", "bing"],
  audit: ["Crawl audit", "抓取与审计", "crawl"],
  performance: ["Page performance", "网页性能", "vitals"],
  geo: ["GEO monitoring", "GEO 监测", "geo"],
  alerts: ["Alerts", "提醒", "alerts"],
} as const;

function sourceInfo(source: string, t: Translator) {
  const report = Object.hasOwn(reports, source) ? reports[source as keyof typeof reports] : null;
  return { label: report ? t(report[0], report[1]) : source, route: report?.[2] };
}

export type ReportSubmission = { title: string; instructions: string; language: "zh-CN" | "en"; actionScope: ActionScope; evidenceRevision: string };
type Preview = ReportEvidence & { revision: string };

export function ReportTask({ siteId, scope, disabled, busy, rejectedRevision, onStart }: {
  siteId: string; scope: ActionScope; disabled: boolean; busy: boolean; rejectedRevision: string | null;
  onStart: (submission: ReportSubmission) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState<"zh-CN" | "en">(locale === "zh" ? "zh-CN" : "en");
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setFailed(false);
    async function load() {
      try {
        const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant/action-evidence?scope=${scope}`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error();
        const snapshot: Preview = await res.json();
        if (snapshot.scope !== scope || snapshot.site.id !== siteId || !/^[a-f0-9]{64}$/.test(snapshot.revision)) throw new Error();
        if (!controller.signal.aborted) setPreview(snapshot);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    }
    void load();
    return () => controller.abort();
  }, [siteId, scope, attempt]);
  const title = reportTitle(scope, t);
  const stale = !!preview && rejectedRevision === preview.revision;
  const ready = !!preview?.hasData && !disabled && !busy && !stale;
  return <form className={s.composer} onSubmit={event => {
    event.preventDefault();
    if (ready && preview) void onStart({ title, instructions, language, actionScope: scope, evidenceRevision: preview.revision });
  }}>
    <div className={s.sectionTitle}><div><h2>{title}</h2><p>{t("Review the saved reports before generating up to three actions.", "核对已保存的数据，再生成最多三项优先行动。")}</p></div></div>
    {preview ? <>
      {preview.truncated && <p className={s.sourceHint}>{t("Some samples were omitted to fit the task size limit.", "部分样本因任务长度限制未带入。")}</p>}
      {(scope === "weekly" || scope === "bing") && <p className={s.reportPeriod}>{t("Search reporting window", "搜索表现时段")} {preview.period.start} – {preview.period.end}<br />
        {t("Comparison", "对比时段")} {preview.period.previousStart} – {preview.period.previousEnd}</p>}
      {preview.sections.map(section => <details key={section.source} className={s.reportSource}>
        <summary>{sourceInfo(section.source, t).label} <span>{section.rows.length ? t("{count} records", "{count} 条记录", { count: section.rows.length }) : t("No saved data", "暂无记录")}</span></summary>
        {section.rows.map((row, i) => <dl key={i}><div><dt>{t("Evidence", "依据")}</dt><dd>{section.source}:{i + 1}</dd></div>{Object.entries(row).map(([key, value]) =>
          <div key={key}><dt>{reportField(key, t)}</dt><dd>{value === null ? t("Unknown", "未知") : typeof value === "boolean" ? (value ? t("Yes", "是") : t("No", "否")) : key === "kind" ? reportField(String(value), t) : String(value)}</dd></div>
        )}</dl>)}
      </details>)}
      {!preview.hasData && <p role="status" className={s.notice}>{t("There is no saved evidence for this analysis yet. Collect data in the source report first.", "当前没有可用于分析的记录，请先到来源报表采集数据。")}</p>}
    </> : <p role="status">{failed ? t("Could not load the evidence.", "读取报表依据失败。") : t("Loading saved evidence…", "正在读取报表依据…")}</p>}
    {stale && <p className={s.validation} role="alert">{t("The report changed. Refresh the evidence and review it before submitting again.", "报表已有更新。请刷新依据，核对后再提交。")}</p>}
    <button type="button" className={s.reviewButton} disabled={busy} onClick={() => { setPreview(null); setAttempt(n => n + 1); }}><RefreshCw size={14} /> {t("Refresh evidence", "刷新依据")}</button>
    <label className={s.field}><span>{t("What should the analysis prioritize?", "希望优先解决什么？")}</span><textarea rows={3} maxLength={6000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder={t("Optional, e.g. prioritize fixes affecting several pages", "选填，例如优先找出一次修改可改善多个页面的问题")} /></label>
    <label className={s.field}><span>{t("Output language", "输出语言")}</span><select value={language} onChange={e => setLanguage(e.target.value === "en" ? "en" : "zh-CN")}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
    <p className={s.privacy}>{t("Generating sends the previewed records and your instructions through the selected ChatGPT connection and uses your account allowance.", "生成时会通过所选 ChatGPT 连接发送上述记录及你的要求，并使用账号额度。")}</p>
    <button type="submit" className={s.primaryButton} disabled={!ready}>{busy ? <Loader2 size={17} className={s.spinning} /> : <Sparkles size={17} />}{t("Generate with my account", "使用账号额度生成")}</button>
  </form>;
}

function reportField(field: string, t: Translator) {
  const labels: Record<string, string> = {
    kind: "记录类型", period: "时段", date: "日期", url: "网址", title: "名称", status: "状态", query: "搜索词",
    clicks: "点击", impressions: "曝光", position: "平均排名", score: "评分", severity: "严重程度",
    count: "数量", citations: "引用次数", visits: "访问次数", source: "数据来源", platform: "平台",
    start: "开始日期", end: "结束日期", expectedDays: "应覆盖天数", clickDays: "有点击记录天数", impressionDays: "有曝光记录天数",
    coveredDays: "有记录天数", observedClicks: "已记录点击", observedImpressions: "已记录曝光", inIndex: "已索引", crawlErrors: "抓取错误",
    blockedByRobots: "被 robots 规则拦截", sampledPages: "抓取页数", pageLimit: "抓取上限", healthScore: "健康分", issue: "发现的问题",
    device: "设备", perfScore: "实验室性能分", lcpSeconds: "LCP（秒）", cls: "CLS", inpMs: "INP（毫秒）", ttfbSeconds: "TTFB（秒）",
    speedIndexSeconds: "速度指数（秒）", enabled: "已启用", verdict: "检查结论", httpStatus: "HTTP 状态", crawlerRequests: "爬虫请求",
    referralSessions: "引荐会话", answerSource: "回答来源", siteCited: "引用本站", observedTraffic: "已记录的搜索表现", topPage: "表现靠前的页面",
    indexSnapshot: "索引快照", crawlSummary: "抓取概况", crawlIssue: "抓取问题", performanceSample: "性能样本", lastAlertTrigger: "最近触发的提醒",
    accessProbe: "爬虫访问检查", botRequests: "爬虫请求", referralTraffic: "引荐流量", officialCitations: "平台报告引用", officialImpressions: "平台报告曝光",
    queryCitations: "搜索词引用明细", answerObservation: "已记录回答", pageRowsTraffic: "已保存页面明细的点击和曝光合计",
  };
  const name = field.replace(/[A-Z]/g, letter => " " + letter.toLowerCase());
  return t(name, labels[field] ?? name);
}

export function ReportActions({ siteId, actions, sources }: {
  siteId: string; actions: NonNullable<WorkbenchResult["reportActions"]>; sources: ReportSource[];
}) {
  const { t } = useI18n();
  const base = `/sites/${encodeURIComponent(siteId)}`;
  return <ol className={s.reportActions}>{actions.map((action, index) => <li key={index}>
    <h4>{index + 1}. {action.title}</h4><p>{action.reason}</p>
    <p><strong>{t("Next step", "下一步")}</strong> {action.nextStep}</p>
    <p><strong>{t("Verify", "如何验证")}</strong> {action.verify}</p>
    <div>{sources.filter(source => action.evidenceRefs.includes(source.ref)).map(item => {
      const { label, route } = sourceInfo(item.source, t);
      if (!route) return null;
      return <span key={item.ref}><Link href={base + "/" + route}>{label} · {item.ref}</Link>
        {item.url && <Link href={base + "/assistant?url=" + encodeURIComponent(item.url)}>{item.url}</Link>}</span>;
    })}</div>
  </li>)}</ol>;
}
