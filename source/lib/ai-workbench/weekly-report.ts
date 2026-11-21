import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { isResearchLanguage } from "@/lib/dataforseo/market";
import { scheduleConfig } from "@/lib/jobs/config";
import { managedAllows } from "@/lib/managed/policy";
import { managedSiteAllows } from "@/lib/managed/worker-owner";
import { reportJobContext } from "./report-context";
import { buildReportWorkerClaim } from "./report-claim";
import { workbenchRequestSchema } from "./schema";

/*
 * The weekly AI action list (AiReportSchedule). A site that turned it on gets
 * one "weekly" report task per week. It is created when the owner's local
 * Codex worker next asks for work after Monday 00:00 UTC, so it never waits
 * in the queue holding the site's task slot while the desktop app is closed.
 * When it finishes, lib/ai-workbench/weekly-queue.ts sends it by email and
 * webhook. A week whose report could not be made is skipped, not retried.
 */

/** Monday 00:00 UTC of the week `now` falls in. */
export function weekSlot(now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

export function weeklyReportTitle(language: string) {
  return language.toLowerCase().startsWith("zh") ? "本周行动清单（自动）" : "Weekly action list (scheduled)";
}

const dueWhere = (slot: Date) => ({ enabled: true, OR: [{ lastSlot: null }, { lastSlot: { lt: slot } }] });

/**
 * Creates this week's report task of one due site the worker may run, and
 * returns its id, or null when no site is due. `userId`: the worker's owner
 * (hosted or managed); null on a single-owner install.
 */
export async function queueDueWeeklyReport(db: PrismaClient, owner: { userId: string | null }, deviceId: string | null, now = new Date()): Promise<string | null> {
  const config = scheduleConfig();
  if (!config.enabled || !config.weeklyAiReport || !managedAllows("codex")) return null;
  const slot = weekSlot(now);
  const due = await db.aiReportSchedule.findFirst({
    where: { ...dueWhere(slot), site: { ...(owner.userId ? { userId: owner.userId } : {}), aiWorkbenchJobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } } } },
    orderBy: { updatedAt: "asc" }, select: { siteId: true, language: true },
  });
  if (!due || !await managedSiteAllows(db, due.siteId)) return null;
  // The week is taken first: a report that cannot be made is not tried again on every poll.
  const taken = await db.aiReportSchedule.updateMany({ where: { siteId: due.siteId, ...dueWhere(slot) }, data: { lastSlot: slot } });
  if (!taken.count) return null;
  try {
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${due.siteId} FOR UPDATE`;
      if (await tx.aiWorkbenchJob.count({ where: { siteId: due.siteId, status: { in: ["QUEUED", "RUNNING"] } } })) return null;
      const site = await tx.site.findUniqueOrThrow({ where: { id: due.siteId }, select: { id: true, domain: true } });
      let built: Awaited<ReturnType<typeof reportJobContext>>;
      try { built = await reportJobContext(tx, site, "weekly", now); }
      catch (error) { if (error instanceof ContentError && error.message === "report_evidence_empty") return null; throw error; }
      const { evidenceRevision, context } = built;
      const language = isResearchLanguage(due.language) ? due.language : "zh-CN";
      const request = workbenchRequestSchema.parse({ provider: "CODEX_LOCAL", kind: "SEO_FIX_PLAN", title: weeklyReportTitle(language), language,
        actionScope: "weekly", evidenceRevision, schedule: "WEEKLY" });
      const jobId = `aw_${randomUUID()}`;
      // Throws when the report does not fit a worker claim: the week is skipped.
      buildReportWorkerClaim(request, context.reportEvidence, { jobId, leaseToken: "0".repeat(36), leaseExpiresAt: now.toISOString() });
      await tx.aiWorkbenchJob.create({ data: { id: jobId, siteId: site.id, hostedDeviceId: deviceId, kind: "SEO_FIX_PLAN", title: request.title,
        request: request as Prisma.InputJsonValue, context: context as unknown as Prisma.InputJsonValue, activeKey: site.id, createdAt: now, updatedAt: now } });
      await tx.aiReportSchedule.update({ where: { siteId: site.id }, data: { lastJobId: jobId } });
      return jobId;
    }, { timeout: 20000 });
  } catch (error) {
    console.error("[workbench] weekly report not created:", error instanceof Error ? error.message : error);
    return null;
  }
}
