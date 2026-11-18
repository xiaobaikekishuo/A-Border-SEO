import type { PrismaClient } from "@prisma/client";
import { APP_VERSION } from "@/lib/version";
import { decisionFingerprint, managedDecision } from "./policy";

export async function managedHealth(db: PrismaClient, now = new Date()) {
  const decision = managedDecision();
  if (!decision.enabled) return null;

  const recent = new Date(now.getTime() - 45_000);
  const blockedJobs = !decision.allowed || !decision.features.jobs;
  const blockedGeo = !decision.allowed || !decision.features.geo;
  const blockedCodex = !decision.allowed || !decision.features.codex;
  const blockedManus = !decision.allowed || !decision.features.manus;
  const [workers, jobs, crawls, plans, drafts, submissions] = await Promise.all([
    db.workerHeartbeat.findMany({
      where: { mode: "worker", lastSeenAt: { gte: recent } },
      select: { version: true, managedPolicy: true },
    }),
    (blockedJobs || blockedGeo) ? db.job.count({
      where: { status: "RUNNING", ...(blockedJobs ? {} : { type: { startsWith: "geo-" } }) },
    }) : 0,
    blockedJobs ? db.crawl.count({ where: { status: "RUNNING" } }) : 0,
    blockedCodex ? db.contentPlanJob.count({ where: { status: "RUNNING" } }) : 0,
    blockedCodex ? db.aiWorkbenchJob.count({ where: { status: "RUNNING" } }) : 0,
    blockedManus ? db.manusKeywordTask.count({
      where: { status: "submitting", createdAt: { gt: new Date(now.getTime() - 120_000) } },
    }) : 0,
  ]);

  const fingerprint = decisionFingerprint(decision);
  const workerApplied = workers.length > 0 && workers.every((worker) => (
    worker.version === APP_VERSION && worker.managedPolicy === fingerprint
  ));
  const activeJobs = jobs + crawls + plans + drafts + submissions;
  return {
    enabled: true, allowed: decision.allowed, reason: decision.reason,
    revision: decision.revision, sequence: decision.sequence,
    appApplied: true, workerApplied, workersSeen: workers.length, activeJobs,
    hostGuardApplied: true,
    phase: !workerApplied ? "pending" : activeJobs > 0 ? "draining" : "effective",
  };
}
