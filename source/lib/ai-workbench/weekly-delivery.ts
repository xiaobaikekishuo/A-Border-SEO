import type { Job, PrismaClient } from "@prisma/client";
import { emailAvailable } from "@/lib/email/config";
import { sendEmail, type EmailMessage } from "@/lib/email/send";
import { getAlertEmail, getWebhook } from "@/lib/user-settings";
import { webhooksEnabled } from "@/lib/webhooks/config";
import { appUrl, sendWebhook } from "@/lib/webhooks/deliver";
import { APP_VERSION } from "@/lib/version";
import { isPermanentJobError, JobError, type JobHandler } from "@/lib/jobs/types";
import { workbenchResultSchema } from "./schema";
import { resultHref } from "./job-link";

/*
 * Delivery of a finished weekly AI action list (lib/ai-workbench/weekly-report.ts)
 * through the owner's alert email and webhook, one job each, retried by the
 * queue like the alert deliveries. Plain text and simple HTML, no tracking,
 * no link except to this instance.
 */

export const WEEKLY_REPORT_EMAIL_JOB = "ai-report-email";
export const WEEKLY_REPORT_WEBHOOK_JOB = "ai-report-webhook";

export type WeeklyReport = {
  jobId: string; siteId: string; userId: string; domain: string; title: string; language: string;
  finishedAt: string | null; period: { start: string; end: string } | null; summary: string;
  actions: { title: string; reason: string; nextStep: string; verify: string }[];
};

async function loadReport(db: PrismaClient, job: Job): Promise<WeeklyReport> {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as { workbenchJobId?: unknown } : null;
  const id = typeof payload?.workbenchJobId === "string" ? payload.workbenchJobId : null;
  if (!id) throw new JobError("The delivery names no report", { code: "EMPTY", permanent: true });
  const row = await db.aiWorkbenchJob.findFirst({ where: { id, siteId: job.siteId, status: "SUCCEEDED" },
    select: { id: true, siteId: true, title: true, request: true, result: true, context: true, finishedAt: true, site: { select: { userId: true, domain: true } } } });
  const result = row ? workbenchResultSchema.safeParse(row.result).data : undefined;
  if (!row || !result?.reportActions) throw new JobError("The report is no longer available", { code: "EMPTY", permanent: true });
  const request = row.request && typeof row.request === "object" && !Array.isArray(row.request) ? row.request as { language?: unknown } : {};
  const evidence = row.context && typeof row.context === "object" && !Array.isArray(row.context)
    ? (row.context as { reportEvidence?: { period?: { start?: unknown; end?: unknown } } }).reportEvidence : undefined;
  const period = typeof evidence?.period?.start === "string" && typeof evidence.period.end === "string" ? { start: evidence.period.start, end: evidence.period.end } : null;
  return { jobId: row.id, siteId: row.siteId, userId: row.site.userId, domain: row.site.domain, title: row.title,
    language: typeof request.language === "string" ? request.language : "zh-CN", finishedAt: row.finishedAt?.toISOString() ?? null, period,
    summary: result.summary, actions: result.reportActions.map(({ title, reason, nextStep, verify }) => ({ title, reason, nextStep, verify })) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
// Straight to this list in the Codex workbench.
const reportLink = (report: WeeklyReport) => { const base = appUrl(); return base ? `${base}${resultHref(report.siteId, "SEO_FIX_PLAN", report.jobId)}` : null; };

/** The weekly action list of one site as one email, in the report's language. */
export function weeklyReportEmail(to: string[], report: WeeklyReport): EmailMessage {
  const zh = report.language.toLowerCase().startsWith("zh");
  const domain = oneLine(report.domain);
  const subject = zh ? `[A-Border SEO] 本周行动清单：${domain}` : `[A-Border SEO] Weekly action list: ${domain}`;
  const window = report.period ? (zh ? `数据时段 ${report.period.start} 至 ${report.period.end}。` : `Data from ${report.period.start} to ${report.period.end}.`) : "";
  const intro = zh ? `${domain} 本周的 SEO 行动清单，由你的本机 Codex 根据已保存的数据生成，没有修改网站。${window}` : `This week's SEO actions for ${domain}, written by your local Codex from saved data. Nothing on the website was changed. ${window}`.trim();
  const labels = zh ? { next: "下一步", verify: "如何验证", open: "在 A-Border SEO 中查看", off: "在“提醒”页可以关闭每周 AI 行动清单。" }
    : { next: "Next step", verify: "How to verify", open: "Open in A-Border SEO", off: "Turn the weekly AI action list off on the Alerts page." };
  const link = reportLink(report);
  const text = [intro, "", oneLine(report.summary), "",
    ...report.actions.flatMap((action, i) => [`${i + 1}. ${oneLine(action.title)}`, `   ${oneLine(action.reason)}`, `   ${labels.next}: ${oneLine(action.nextStep)}`, `   ${labels.verify}: ${oneLine(action.verify)}`, ""]),
    ...(link ? [`${labels.open}: ${link}`, ""] : []), labels.off].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111">`
    + `<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(zh ? `本周行动清单：${domain}` : `Weekly action list: ${domain}`)}</h1>`
    + `<p style="margin:0 0 12px">${escapeHtml(intro)}</p><p style="margin:0 0 12px">${escapeHtml(oneLine(report.summary))}</p><ol style="margin:0 0 12px;padding-left:20px">`
    + report.actions.map(action => `<li style="margin:0 0 10px"><strong>${escapeHtml(oneLine(action.title))}</strong><br>${escapeHtml(oneLine(action.reason))}<br>`
      + `<em>${escapeHtml(labels.next)}:</em> ${escapeHtml(oneLine(action.nextStep))}<br><em>${escapeHtml(labels.verify)}:</em> ${escapeHtml(oneLine(action.verify))}</li>`).join("")
    + `</ol>${link ? `<p style="margin:0 0 12px"><a href="${escapeHtml(link)}">${escapeHtml(labels.open)}</a></p>` : ""}`
    + `<p style="margin:16px 0 0;color:#666;font-size:12px">${escapeHtml(labels.off)}</p></body></html>`;
  return { to, subject, text, html };
}

/** The body of a report.weekly webhook delivery. */
export function weeklyReportPayload(deliveryId: string, report: WeeklyReport) {
  return {
    event: "report.weekly" as const,
    id: deliveryId,
    generatedAt: report.finishedAt,
    site: { id: report.siteId, domain: report.domain },
    report: { jobId: report.jobId, title: report.title, language: report.language, period: report.period, summary: report.summary,
      actions: report.actions, url: reportLink(report) },
    app: { name: "a-border-seo", version: APP_VERSION },
  };
}

export const weeklyReportEmailHandler: JobHandler = {
  type: WEEKLY_REPORT_EMAIL_JOB,
  class: "SHORT",
  maxAttempts: 3,
  isPermanent: isPermanentJobError,
  async run({ db, job }) {
    if (!emailAvailable()) throw new JobError("Alert emails are turned off or not set up on this server", { code: "EMAIL_OFF", permanent: true });
    const report = await loadReport(db, job);
    const settings = await getAlertEmail(db, report.userId);
    if (!settings.enabled || settings.recipients.length === 0) throw new JobError("Alert emails are off in Settings", { code: "NOT_CONFIGURED", permanent: true });
    const result = await sendEmail(weeklyReportEmail(settings.recipients, report));
    if (!result.ok) throw new JobError(result.error, { code: "SMTP", permanent: !result.retryable });
    return { recipients: settings.recipients.length, actions: report.actions.length };
  },
};

export const weeklyReportWebhookHandler: JobHandler = {
  type: WEEKLY_REPORT_WEBHOOK_JOB,
  class: "SHORT",
  maxAttempts: 5,
  isPermanent: isPermanentJobError,
  async run({ db, job }) {
    if (!webhooksEnabled()) throw new JobError("Alert webhooks are turned off on this server", { code: "WEBHOOKS_OFF", permanent: true });
    const report = await loadReport(db, job);
    const webhook = await getWebhook(db, report.userId);
    if (!webhook) throw new JobError("No webhook is set in Settings", { code: "NOT_CONFIGURED", permanent: true });
    const result = await sendWebhook(webhook.url, webhook.secret, "report.weekly", weeklyReportPayload(job.id, report));
    if (!result.ok) throw new JobError(result.error, { code: result.status ? `HTTP_${result.status}` : "UNREACHABLE", permanent: !result.retryable });
    return { status: result.status, actions: report.actions.length };
  },
};
