import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ownedSite } from "@/lib/content-planner/data";
import { isResearchLanguage, RESEARCH_LANGUAGE_VALUES } from "@/lib/dataforseo/market";
import { DAY, scheduleConfig } from "@/lib/jobs/config";
import { hasAlertEmail, hasAlertWebhook } from "@/lib/jobs/handlers";
import { weekSlot } from "./weekly-report";

/* The weekly AI action list switch of a site (Alerts page). */

const saveSchema = z.object({ enabled: z.boolean(), language: z.enum(RESEARCH_LANGUAGE_VALUES) }).strict();

export type WeeklyReportView = {
  enabled: boolean; language: string;
  /** False when the server turned scheduled work off (SCHEDULER_ENABLED or SCHEDULE_WEEKLY_AI_REPORT). */
  scheduler: boolean;
  /** When the next list is due: from then on, the worker writes it on its next poll. */
  nextDue: string;
  /** This week's list is due and not written yet: the worker writes it when it is next idle. */
  dueNow: boolean;
  delivery: { email: boolean; webhook: boolean };
  lastJob: { id: string; status: string; title: string; createdAt: string; finishedAt: string | null; error: string | null } | null;
};

export async function getWeeklyReport(db: PrismaClient, userId: string | undefined | null, siteId: string, now = new Date()): Promise<WeeklyReportView> {
  const site = await ownedSite(db, userId, siteId);
  const [row, market, email, webhook] = await Promise.all([
    db.aiReportSchedule.findUnique({ where: { siteId: site.id } }),
    db.site.findUnique({ where: { id: site.id }, select: { researchLanguage: true } }),
    hasAlertEmail(db, userId!), hasAlertWebhook(db, userId!),
  ]);
  const job = row?.lastJobId ? await db.aiWorkbenchJob.findFirst({ where: { id: row.lastJobId, siteId: site.id },
    select: { id: true, status: true, title: true, createdAt: true, finishedAt: true, error: true } }) : null;
  const config = scheduleConfig();
  const slot = weekSlot(now);
  const handled = !!row?.lastSlot && row.lastSlot.getTime() >= slot.getTime();
  return {
    enabled: row?.enabled ?? false,
    language: row?.language ?? (isResearchLanguage(market?.researchLanguage) ? market!.researchLanguage : "zh-CN"),
    scheduler: config.enabled && config.weeklyAiReport,
    nextDue: new Date(handled ? slot.getTime() + 7 * DAY : slot.getTime()).toISOString(),
    dueNow: !handled,
    delivery: { email, webhook },
    lastJob: job ? { id: job.id, status: job.status, title: job.title, createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null, error: job.error } : null,
  };
}

/** Turning it on mid-week writes this week's list on the worker's next poll; on, off and on again in one week does not write a second. */
export async function saveWeeklyReport(db: PrismaClient, userId: string | undefined | null, siteId: string, body: unknown, now = new Date()) {
  const site = await ownedSite(db, userId, siteId);
  const input = saveSchema.parse(body);
  await db.aiReportSchedule.upsert({ where: { siteId: site.id }, create: { siteId: site.id, enabled: input.enabled, language: input.language },
    update: { enabled: input.enabled, language: input.language } });
  return getWeeklyReport(db, userId, siteId, now);
}
