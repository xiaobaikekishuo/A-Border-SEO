import { z } from "zod";
import { articleReviewSchema, articleReviewRequestSchema, articleReviewPrompt, validateArticleReview } from "./article-review-schema";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ContentError } from "./http";
import { aggregateUrlMetrics, expireContentJobs, LEASE_MS, metricWindow, RUN_TIMEOUT_MS, type PlannerDb } from "./data";
import { buildContentPrompt } from "./prompt";
import { outputSchema, siteUrl, validateBriefLinks, workerActionSchema } from "./schema";
import { expireWorkbenchJobs } from "@/lib/ai-workbench/data";
import { claimWorkbenchJob, runWorkbenchLease } from "@/lib/ai-workbench/worker";
import { storedUsage } from "@/lib/ai-usage/schema";
import { storedFunnelCounts, matchesFunnelCounts } from "./funnel";

async function workerSeen(db: PlannerDb, workerId: string, now: Date) {
  await db.contentWorkerState.upsert({ where: { id: workerId }, create: { id: workerId, lastSeenAt: now }, update: { lastSeenAt: now } });
}
async function claimContext(db: PlannerDb, job: { siteId: string; pillarId: string; topicCount: number; request?: unknown }) {
  const [site, pillar, existingTopics, crawl, window] = await Promise.all([
    db.site.findUniqueOrThrow({ where: { id: job.siteId }, select: { domain: true } }),
    db.contentPillar.findFirstOrThrow({ where: { id: job.pillarId, siteId: job.siteId }, select: { title: true, keyword: true, description: true, audience: true, goal: true, url: true } }),
    db.contentCluster.findMany({ where: { siteId: job.siteId }, take: 100, orderBy: { createdAt: "desc" }, select: { title: true, keyword: true, url: true } }),
    db.crawl.findFirst({ where: { siteId: job.siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } }),
    metricWindow(db, job.siteId),
  ]);
  const [knownPages, searchRows] = await Promise.all([
    crawl ? db.auditPage.findMany({ where: { crawlId: crawl.id, statusCode: 200, indexable: true }, take: 300, orderBy: { url: "asc" }, select: { url: true, title: true } }) : [],
    window ? db.page.findMany({ where: { siteId: job.siteId, date: { gte: window.start, lte: window.end } }, select: { url: true, clicks: true, impressions: true, position: true } }) : [],
  ]);
  const searchEvidence = window ? [...aggregateUrlMetrics(searchRows, window.period)]
    .sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 50)
    .map(([url, m]) => ({ url, clicks: m.clicks, impressions: m.impressions, position: m.position })) : [];
  const allowedInternalLinks = [...new Set([...knownPages.map((page) => page.url), ...searchEvidence.map((page) => page.url)].flatMap((url) => {
    try { const target = siteUrl(url, site.domain); return target ? [target] : []; } catch { return []; }
  }))];
  return { domain: site.domain, topicCount: job.topicCount, funnelCounts: storedFunnelCounts(job.request, job.topicCount), pillar, existingTopics, knownPages, searchEvidence, metricsPeriod: window?.period ?? null, allowedInternalLinks };
}
function leaseWhere(jobId: string, leaseToken: string, now: Date) {
  return { id: jobId, status: "RUNNING" as const, leaseToken, leaseExpiresAt: { gt: now }, startedAt: { gt: new Date(now.getTime() - RUN_TIMEOUT_MS) } };
}
export async function runWorkerAction(db: PlannerDb, input: unknown, now = new Date()) {
  const action = workerActionSchema.parse(input);
  await expireContentJobs(db, now);
  await expireWorkbenchJobs(db, now);
  if (action.action !== "claim" && action.jobId?.startsWith("aw_")) {
    if (!action.leaseToken) throw new ContentError("Provide both jobId and leaseToken for a job heartbeat");
    return runWorkbenchLease(db, { ...action, jobId: action.jobId, leaseToken: action.leaseToken }, now);
  }
  if (action.action === "heartbeat") {
    if (!!action.jobId !== !!action.leaseToken) throw new ContentError("Provide both jobId and leaseToken for a job heartbeat");
    if (action.jobId && action.leaseToken) {
      const where = leaseWhere(action.jobId, action.leaseToken, now);
      const job = await db.contentPlanJob.findFirst({ where, select: { startedAt: true } });
      if (!job?.startedAt) throw new ContentError("Job lease is no longer valid", 409);
      const leaseExpiresAt = new Date(Math.min(now.getTime() + LEASE_MS, job.startedAt.getTime() + RUN_TIMEOUT_MS));
      const result = await db.contentPlanJob.updateMany({ where, data: { leaseExpiresAt } });
      if (!result.count) throw new ContentError("Job lease is no longer valid", 409);
      await workerSeen(db, action.workerId, now);
      return { ok: true, leaseExpiresAt: leaseExpiresAt.toISOString() };
    }
    await workerSeen(db, action.workerId, now);
    return { ok: true };
  }
  if (action.action === "claim") {
    await workerSeen(db, action.workerId, now);
    const [candidate, workbench] = await Promise.all([
      db.contentPlanJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } }),
      db.aiWorkbenchJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true } }),
    ]);
    if (workbench && (!candidate || workbench.createdAt < candidate.createdAt)) return claimWorkbenchJob(db, workbench.id, now);
    if (!candidate) return { job: null };
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const changed = await db.contentPlanJob.updateMany({ where: { id: candidate.id, status: "QUEUED" },
      data: { status: "RUNNING", leaseToken, leaseExpiresAt, startedAt: now } });
    if (!changed.count) return { job: null };
    try {
      const isReview = candidate.kind === "ARTICLE_REVIEW";
      const context = isReview ? articleReviewRequestSchema.parse(candidate.request) : await claimContext(db, candidate);
      const saved = await db.contentPlanJob.updateMany({ where: { id: candidate.id, status: "RUNNING", leaseToken },
        data: { context: context as Prisma.InputJsonValue } });
      if (!saved.count) throw new ContentError("Job lease is no longer valid", 409);
      return { job: { jobId: candidate.id, leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString(),
        prompt: isReview ? articleReviewPrompt(articleReviewRequestSchema.parse(context)) : buildContentPrompt(context as Awaited<ReturnType<typeof claimContext>>), outputSchema: isReview ? z.toJSONSchema(articleReviewSchema, { target: "draft-7" }) : outputSchema } };
    } catch (error) {
      await db.contentPlanJob.updateMany({ where: { id: candidate.id, leaseToken, status: "RUNNING" },
        data: { status: "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null, finishedAt: now, error: "Unable to prepare generation context" } });
      throw error;
    }
  }
  const where = leaseWhere(action.jobId, action.leaseToken, now);
  const job = await db.contentPlanJob.findFirst({ where, include: { site: { select: { domain: true } } } });
  if (!job) throw new ContentError("Job lease is no longer valid", 409);
  let result: Prisma.InputJsonValue | undefined;
  if (action.action === "complete") {
    if (job.kind === "ARTICLE_REVIEW") {
      result = validateArticleReview(action.result, articleReviewRequestSchema.parse(job.request)) as Prisma.InputJsonValue;
    } else {
    if (!("topics" in action.result)) throw new ContentError("Expected topic plan result");
    if (action.result.topics.length !== job.topicCount) throw new ContentError(`Expected exactly ${job.topicCount} topics`);
    try {
      if (!matchesFunnelCounts(action.result.topics, storedFunnelCounts(job.request, job.topicCount))) throw new ContentError("Generated topics do not match this task's funnel distribution");
      result = { ...action.result, topics: action.result.topics.map((topic) => ({ ...topic, brief: validateBriefLinks(topic.brief, job.site.domain) })) } as Prisma.InputJsonValue;
      const context = job.context as { allowedInternalLinks?: unknown } | null;
      const allowed = new Set(Array.isArray(context?.allowedInternalLinks) ? context.allowedInternalLinks.filter((url): url is string => typeof url === "string") : []);
      for (const topic of action.result.topics) {
        for (const link of topic.brief.internalLinks) {
          if (!allowed.has(siteUrl(link.target, job.site.domain)!)) throw new ContentError("AI internal links must use the verified URL evidence supplied with this job");
        }
      }
    } catch (error) { throw new ContentError((error as Error).message); }
    }
  }
  const usage = storedUsage(action.usage);
  const changed = await db.contentPlanJob.updateMany({ where, data: {
    status: action.action === "complete" ? "SUCCEEDED" : "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null,
    finishedAt: now, ...(result ? { result } : {}), error: action.action === "fail" ? action.error : null,
    ...(usage ? { usage: usage as Prisma.InputJsonValue } : {}),
  } });
  if (!changed.count) throw new ContentError("Job lease is no longer valid", 409);
  return { ok: true };
}
