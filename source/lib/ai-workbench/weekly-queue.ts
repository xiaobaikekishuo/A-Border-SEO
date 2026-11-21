import type { PrismaClient } from "@prisma/client";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { hasAlertEmail, hasAlertWebhook } from "@/lib/jobs/handlers";
import { enqueueJob } from "@/lib/jobs/queue";
import { WEEKLY_REPORT_EMAIL_JOB, WEEKLY_REPORT_WEBHOOK_JOB } from "./weekly-delivery";

/**
 * Queues the delivery of a finished weekly action list: one webhook delivery
 * and one email, each only when the owner set that channel up.
 */
export async function queueWeeklyReportDelivery(db: PrismaClient, workbenchJobId: string, siteId: string) {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true } });
  if (!site) return [];
  const [webhook, email] = await Promise.all([hasAlertWebhook(db, site.userId), hasAlertEmail(db, site.userId)]);
  const jobs = [];
  for (const type of [...(webhook ? [WEEKLY_REPORT_WEBHOOK_JOB] : []), ...(email ? [WEEKLY_REPORT_EMAIL_JOB] : [])]) {
    const { job } = await enqueueJob(db, { type, siteId, source: "schedule", payload: { workbenchJobId }, unique: false });
    jobs.push(job);
    dispatchJob(db, job);
  }
  return jobs;
}
