"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BarChart3, ChevronDown, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { AiUsageReport } from "@/lib/ai-usage/report";
import { CHATGPT_USAGE_URL } from "./chatgpt-connection";
import s from "./usage-panel.module.css";

type UsageState = { key: string; data: AiUsageReport | null; error: boolean; loading: boolean };

export function UsagePanel({ siteId, refreshKey }: { siteId: string; refreshKey: string }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [scope, setScope] = useState<"site" | "all">("site");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<UsageState | null>(null);
  const sequence = useRef(0);
  const endpoint = `/api/ai-usage?days=${days}${scope === "site" ? `&siteId=${encodeURIComponent(siteId)}` : ""}`;

  useEffect(() => {
    const controller = new AbortController();
    const request = ++sequence.current;
    setState({ key: endpoint, data: null, error: false, loading: true });
    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        const report = await response.json() as AiUsageReport;
        if (!response.ok || report?.period?.days !== days || report?.scope?.siteId !== (scope === "site" ? siteId : null)
          || !report.summary || !Array.isArray(report.recent) || !Array.isArray(report.providers)) throw new Error("usage_unavailable");
        if (!controller.signal.aborted && request === sequence.current) setState({ key: endpoint, data: report, error: false, loading: false });
      } catch {
        if (!controller.signal.aborted && request === sequence.current) setState({ key: endpoint, data: null, error: true, loading: false });
      }
    })();
    return () => { controller.abort(); sequence.current++; };
  }, [endpoint, days, scope, siteId, revision, refreshKey]);

  // A response from a preceding scope is never displayed while switching sites.
  const current = state?.key === endpoint ? state : null;
  const loading = !current || current.loading;
  const report = current?.data;
  const date = (value: string) => new Date(value).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
  return <section className={s.panel} aria-label={t("A-Border SEO usage", "本平台用量统计")}>
    <div className={s.header}>
      <div className={s.title}><BarChart3 size={20} aria-hidden="true" /><div><h2>{t("A-Border SEO usage", "本平台用量统计")}</h2><p>{t("Tasks owned by this A-Border SEO user, across saved ChatGPT connections.", "此 A-Border SEO 用户的任务统计，包含不同 ChatGPT 连接。")}</p></div></div>
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className={s.manage}>{t("Manage ChatGPT usage", "查看 ChatGPT 账号额度")}<ArrowUpRight size={15} aria-hidden="true" /></a>
    </div>
    <div className={s.toolbar}>
      <div className={s.filters}>
        <label><span>{t("Period", "时间范围")}</span><select value={days} onChange={event => setDays(Number(event.target.value) as 7 | 30 | 90)}>{([7, 30, 90] as const).map(value => <option value={value} key={value}>{t(`Last ${value} days`, `最近 ${value} 天`)}</option>)}</select></label>
        <label><span>{t("Sites", "站点范围")}</span><select value={scope} onChange={event => setScope(event.target.value as "site" | "all")}><option value="site">{t("This site", "当前网站")}</option><option value="all">{t("All my sites", "我的全部网站")}</option></select></label>
      </div>
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} className={s.refresh}><RefreshCw size={14} className={loading ? s.spinning : ""} aria-hidden="true" />{t("Refresh usage", "刷新统计")}</button>
    </div>
    <p className={s.boundary}>{t("Plan allowance and reset times are available in ChatGPT. These task and token records cover A-Border SEO only; tokens cannot be converted directly into your remaining plan allowance or charges.", "套餐剩余额度和重置时间请在 ChatGPT 查看。这里仅统计 A-Border SEO 的任务与 Token，不能直接换算为套餐剩余额度或费用。")}</p>
    {loading ? <p className={s.message} role="status">{t("Loading usage records…", "正在读取用量记录…")}</p> : current?.error ? <p className={`${s.message} ${s.error}`} role="alert">{t("Usage records could not be loaded. Refresh to try again; no AI request will be sent.", "暂时无法读取用量记录，请刷新重试；刷新不会发送 AI 生成请求。")}</p> : report ? <>
      <UsageReportView report={report} />
      <p className={s.period}>{date(report.period.start)} ~ {date(report.period.end)} · {t("Grouped by task creation time. Failed or canceled tasks may still consume tokens.", "按任务创建时间统计。失败或取消的任务也可能已消耗 Token。")}</p>
    </> : null}
  </section>;
}

export function UsageReportView({ report }: { report: AiUsageReport }) {
  const { t, locale } = useI18n();
  const number = (value: number | null) => value === null ? t("Unknown", "未知") : value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const providerName = (provider: string) => provider === "CHATGPT_APP" ? t("ChatGPT app", "ChatGPT 应用") : provider === "CODEX_LOCAL" ? t("Codex account", "Codex 账号") : t("Unrecorded source", "来源未记录");
  const statusName = (status: AiUsageReport["recent"][number]["status"]) => ({ SUCCEEDED: t("Completed", "已完成"), FAILED: t("Failed / canceled", "失败／取消"), QUEUED: t("Queued", "排队中"), RUNNING: t("Running", "处理中") })[status];
  const kinds: Record<string, string> = { WRITE_ARTICLE: t("Article draft", "文章草稿"), REWRITE_ARTICLE: t("Article rewrite", "文章改写"), SEO_FIX_PLAN: t("SEO fix plan", "修复方案"), KEYWORD_RESEARCH: t("Keyword research", "关键词研究"), DOMAIN_ANALYSIS: t("Domain diagnosis", "域名诊断"), BACKLINK_ANALYSIS: t("Link analysis", "链接分析"), BRIEF: t("Content brief", "内容简报") };
  const kindName = (kind: string) => kinds[kind] ?? t("Content planning", "内容规划");
  const { summary } = report;
  const coverage = summary.tasks ? `${Math.round(summary.withUsage / summary.tasks * 100)}%` : t("No tasks", "暂无任务");
  return <>
    <div className={s.cards}>
      <div className={s.card}><span>{t("Tasks", "任务总数")}</span><strong>{number(summary.tasks)}</strong><small>{t("Completed", "已完成")} {number(summary.succeeded)} · {t("Failed / canceled", "失败／取消")} {number(summary.failed)}<br />{t("Queued", "排队中")} {number(summary.queued)} · {t("Running", "处理中")} {number(summary.running)}</small></div>
      <div className={s.card}><span>{t("Recorded input tokens", "已记录输入 Token")}</span><strong>{number(summary.inputTokens)}</strong><small>{t("Includes cached input", "其中缓存输入")} {number(summary.cachedInputTokens)}</small></div>
      <div className={s.card}><span>{t("Recorded output tokens", "已记录输出 Token")}</span><strong>{number(summary.outputTokens)}</strong><small>{t("Includes reasoning", "其中推理")} {number(summary.reasoningTokens)}</small></div>
      <div className={`${s.card} ${s.total}`}><span>{t("Recorded total tokens", "已记录总 Token")}</span><strong>{number(summary.totalTokens)}</strong><small>{t("Sums only reported total-token values.", "仅汇总已返回的总 Token。")}</small></div>
    </div>
    <div className={s.coverage}>
      <span>{t("Tasks with token records", "有 Token 记录的任务")} <strong>{coverage}</strong> <span className={s.coverageCount}>({number(summary.withUsage)} / {number(summary.tasks)})</span></span>
      <p>{t("At least one token field was reported. This is not your plan usage percentage. Fields may be missing independently, so the input and output cards may not add up to the total-token card.", "至少返回一个 Token 字段即计入，不代表套餐额度使用比例。各字段记录可能不完整，因此输入与输出合计不一定等于总 Token 卡片。")}</p>
      <p>{summary.tasks ? t(`${summary.withoutUsage} tasks have no token record. Historical, unfinished, or unreported usage is unknown, not zero. Totals include only returned numbers.`, `${summary.withoutUsage} 个任务没有 Token 记录。历史任务、未完成或接口未返回的用量为未知，不按零处理；合计仅汇总已返回数值。`) : t("No tasks in this period. Token usage has not been recorded.", "此时间范围内暂无任务，尚无 Token 用量记录。")}</p>
    </div>
    <details className={s.details}>
      <summary>{t("Usage by connection type and recent tasks", "按连接方式查看用量与最近任务")}<ChevronDown size={16} aria-hidden="true" /></summary>
      <div className={s.providers}>{report.providers.map(provider => <div key={provider.provider}><strong>{providerName(provider.provider)}</strong><span>{number(provider.tasks)} {t("tasks", "个任务")} · {number(provider.withUsage)} {t("with token records", "个有用量记录")}</span><span>{t("Recorded total", "已记录总量")} <b>{number(provider.totalTokens)}</b> Token</span></div>)}</div>
      {report.recent.length > 0 ? <div className={s.tableScroll} tabIndex={0} role="region" aria-label={t("Recent task usage table", "最近任务用量表")}><table className={s.table}>
        <caption>{t("Up to 20 most recent tasks in this period. Task count is not API request count.", "此时间范围内最近 20 个任务。任务数不等于 API 调用次数。")}</caption>
        <thead><tr><th scope="col">{t("Task / site", "任务／网站")}</th><th scope="col">{t("Connection / model", "连接／模型")}</th><th scope="col">{t("Status", "状态")}</th><th scope="col">{t("Input", "输入")}</th><th scope="col">{t("Output", "输出")}</th><th scope="col">{t("Total tokens", "总 Token")}</th></tr></thead>
        <tbody>{report.recent.map(job => <tr key={job.id}>
          <td><strong>{job.title}</strong><small>{job.domain} · {kindName(job.kind)}</small><small>{new Date(job.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></td>
          <td>{providerName(job.provider)}<small>{job.model || t("Model unrecorded", "模型未记录")}</small></td>
          <td><span className={`${s.status} ${job.status === "SUCCEEDED" ? s.completed : ""}`}>{statusName(job.status)}</span></td>
          <td>{number(job.usage?.inputTokens ?? null)}</td><td>{number(job.usage?.outputTokens ?? null)}</td><td>{number(job.usage?.totalTokens ?? null)}</td>
        </tr>)}</tbody>
      </table></div> : <p className={s.message}>{t("No task records in this period.", "此时间范围内没有任务记录。")}</p>}
    </details>
  </>;
}
