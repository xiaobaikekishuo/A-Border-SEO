import type { PrismaClient } from "@prisma/client";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { enqueueJob } from "@/lib/jobs/queue";
import { RANK_COLLECT_JOB } from "./tracking";

/*
 * The job that collects a site's rank checks once DataForSEO has them. One
 * collector serves every waiting run of a site and queues the next one while
 * runs are still waiting. Kept apart from job.ts: the job queue imports the
 * handlers, so the handlers reach the queue only through this module, loaded
 * when they run.
 */

type Db = PrismaClient;

/**
 * Queues a collector `delayMs` from now, unless one is already queued: then
 * that one is brought forward if it is due later. Never folds into a running
 * collector, which may have finished its pass before this run was posted.
 */
export async function queueCollector(db: Db, siteId: string, delayMs: number): Promise<void> {
  const runAt = new Date(Date.now() + Math.max(0, delayMs));
  const queued = await db.job.findFirst({
    where: { siteId, type: RANK_COLLECT_JOB, status: "QUEUED" },
    orderBy: { runAt: "asc" },
    select: { id: true, runAt: true },
  }) as { id: string; runAt: Date } | null;
  if (queued) {
    if (queued.runAt > runAt) await db.job.updateMany({ where: { id: queued.id, status: "QUEUED" }, data: { runAt } });
    return;
  }
  await enqueueJob(db, { type: RANK_COLLECT_JOB, siteId, source: "chain", runAt, unique: false });
}

/**
 * While the rank tracking screen is open: a site with runs waiting for
 * results gets a collector, and one that is due runs now. On a host where no
 * process polls the queue (serverless), this is what moves a run along.
 */
export async function ensureCollector(db: Db, siteId: string): Promise<void> {
  const waiting = await db.rankRun.count({ where: { siteId, status: "WAITING" } }) as number;
  if (!waiting) return;
  const job = await db.job.findFirst({
    where: { siteId, type: RANK_COLLECT_JOB, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { runAt: "asc" },
    select: { id: true, status: true, runAt: true },
  }) as { id: string; status: "QUEUED" | "RUNNING"; runAt: Date } | null;
  if (job?.status === "RUNNING") return;
  if (job) {
    if (job.runAt <= new Date()) dispatchJob(db, job);
    return;
  }
  await queueCollector(db, siteId, 0);
  const created = await db.job.findFirst({
    where: { siteId, type: RANK_COLLECT_JOB, status: "QUEUED" },
    orderBy: { runAt: "asc" },
    select: { id: true, status: true },
  });
  if (created) dispatchJob(db, created);
}
