import { ARTICLE_REVIEW_OUTPUT_SCHEMA, articleReviewRequestSchema, articleReviewPrompt, finalizeArticleReview } from "./article-review-schema";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ContentError } from "./http";
import { aggregateUrlMetrics, expireContentJobs, LEASE_MS, metricWindow, RUN_TIMEOUT_MS, type PlannerDb } from "./data";
import { buildContentPrompt } from "./prompt";
import { outputSchema, workerActionSchema } from "./schema";
import { expireWorkbenchJobs } from "@/lib/ai-workbench/data";
import { verifiedPageMatcher } from "@/lib/ai-workbench/source-url";
import { claimWorkbenchJob, runWorkbenchLease } from "@/lib/ai-workbench/worker";
import { storedUsage } from "@/lib/ai-usage/schema";
import { storedFunnelCounts, matchesFunnelCounts } from "./funnel";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { managedAllows, managedDecision } from "@/lib/managed/policy";
import { managedUserScope } from "@/lib/managed/identity";
import { managedSiteAllows } from "@/lib/managed/worker-owner";
import { hostedLeaseScope, hostedClaimScope } from "@/lib/hosted/worker";
import { hostedContext } from "@/lib/hosted/context";
import { savedResearchSchema } from "./keyword-selection";
import { fitPlanReferences, PLAN_TOO_LARGE } from "./claim-size";
import { queueDueWeeklyReport } from "@/lib/ai-workbench/weekly-report";
import { claimHints, queuePoolJob, recordWorkerLimits, workerStateId } from "@/lib/ai-workbench/pool/queue";
import { withHint } from "@/lib/ai-workbench/pool/routing";

async function workerSeen(db: PlannerDb, workerId: string, now: Date) {
  const id = workerStateId(workerId, hostedContext.getStore());
  await db.contentWorkerState.upsert({ where: { id }, create: { id, lastSeenAt: now }, update: { lastSeenAt: now } });
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
  const research = job.request && typeof job.request === "object" && "research" in job.request
    ? savedResearchSchema.parse(job.request.research) : null;
  return fitPlanReferences({ domain: site.domain, topicCount: job.topicCount, funnelCounts: storedFunnelCounts(job.request, job.topicCount),
    pillar, ...(research && { reviewedKeywordIdeas: research.ideas }) }, { existingTopics, knownPages, searchEvidence, metricsPeriod: window?.period ?? null });
}
function leaseWhere(jobId: string, leaseToken: string, now: Date) {
  return { id: jobId, status: "RUNNING" as const, leaseToken, leaseExpiresAt: { gt: now }, startedAt: { gt: new Date(now.getTime() - RUN_TIMEOUT_MS) }, ...hostedLeaseScope() };
}
export async function runWorkerAction(db: PlannerDb, input: unknown, now = new Date()) {
  const action = workerActionSchema.parse(input);
  const expiryScope = await managedUserScope(db);
  if (!expiryScope.managed || expiryScope.userId) {
    await expireContentJobs(db, now, undefined, expiryScope.userId ?? undefined);
    await expireWorkbenchJobs(db, now, undefined, expiryScope.userId ?? undefined);
  }
  if (action.action === "begin") {
    const where = { ...leaseWhere(action.jobId, action.leaseToken, now), executionAuthorizedAt: null };
    const scope = await managedUserScope(db);
    const scopedWhere = { ...where, ...(scope.managed && { site: { userId: scope.userId ?? "" } }) };
    const owner = action.jobId.startsWith("aw_")
      ? await db.aiWorkbenchJob.findFirst({ where: scopedWhere, select: { id: true } })
      : await db.contentPlanJob.findFirst({ where: scopedWhere, select: { id: true } });
    const allowed = Boolean(owner) && !desktopMaintenanceActive() && managedAllows("codex");
    const data = allowed ? { executionAuthorizedAt: now } : {
      status: "QUEUED" as const, leaseToken: null, leaseExpiresAt: null, startedAt: null,
    };
    const changed = action.jobId.startsWith("aw_")
      ? await db.aiWorkbenchJob.updateMany({ where, data })
      : await db.contentPlanJob.updateMany({ where, data });
    return { ok: true, allowed: allowed && changed.count === 1 };
  }
  if (action.action === "limits") {
    // The worker's Codex allowance, read without sending a message: the background pool runs on it.
    await recordWorkerLimits(db, workerStateId(action.workerId, hostedContext.getStore()), action, now);
    return { ok: true };
  }
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
    const decision = managedDecision();
    const protocol = decision.enabled ? { managedProtocol: 2 } : {};
    if (decision.enabled && action.protocolVersion !== 2) return { ...protocol, job: null };
    if (desktopMaintenanceActive() || !decision.allowed || !decision.features.codex) return { ...protocol, job: null };
    const scope = await managedUserScope(db);
    if (scope.managed && !scope.userId) return { ...protocol, job: null };
    const ownerFilter = { ...(scope.managed ? { site: { userId: scope.userId! } } : {}), ...hostedClaimScope() };
    const [candidate, workbench] = await Promise.all([
      db.contentPlanJob.findFirst({ where: { status: "QUEUED", ...ownerFilter }, orderBy: { createdAt: "asc" } }),
      db.aiWorkbenchJob.findFirst({ where: { status: "QUEUED", ...ownerFilter }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true } }),
    ]);
    if (desktopMaintenanceActive() || !managedAllows("codex")) return { ...protocol, job: null };
    const hosted = hostedContext.getStore();
    const worker = await db.contentWorkerState.findUnique({ where: { id: workerStateId(action.workerId, hosted) }, select: { limits: true, limitsAt: true, models: true, capabilities: true } });
    const hints = claimHints(db, worker);
    if (workbench && (!candidate || workbench.createdAt < candidate.createdAt)) {
      return { ...protocol, ...(await claimWorkbenchJob(db, workbench.id, now, hints)) };
    }
    if (!candidate) {
      // Nothing waiting: this week's AI action list of a site that turned it on, if due, else background pool work.
      const owner = { userId: hosted?.userId ?? (scope.managed ? scope.userId : null) };
      const weekly = await queueDueWeeklyReport(db, owner, hosted?.deviceId ?? null, now);
      if (weekly) return { ...protocol, ...(await claimWorkbenchJob(db, weekly, now, hints)) };
      const pooled = await queuePoolJob(db, owner, hosted?.deviceId ?? null, worker, now);
      return pooled ? { ...protocol, ...(await claimWorkbenchJob(db, pooled, now, hints)) } : { ...protocol, job: null };
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const changed = await db.contentPlanJob.updateMany({ where: { id: candidate.id, status: "QUEUED", ...ownerFilter },
      data: { status: "RUNNING", leaseToken, leaseExpiresAt, startedAt: now, executionAuthorizedAt: null,
        ...(hostedContext.getStore() ? { hostedDeviceId: hostedContext.getStore()!.deviceId } : {}) } });
    if (!changed.count) return { ...protocol, job: null };
    try {
      const isReview = candidate.kind === "ARTICLE_REVIEW";
      const context = isReview ? articleReviewRequestSchema.parse(candidate.request) : await claimContext(db, candidate);
      if (!await managedSiteAllows(db, candidate.siteId)) {
        await db.contentPlanJob.updateMany({ where: { id: candidate.id, status: "RUNNING", leaseToken },
          data: { status: "QUEUED", leaseToken: null, leaseExpiresAt: null, startedAt: null } });
        return { ...protocol, job: null };
      }
      const saved = await db.contentPlanJob.updateMany({ where: { id: candidate.id, status: "RUNNING", leaseToken },
        data: { context: context as Prisma.InputJsonValue } });
      if (!saved.count) throw new ContentError("Job lease is no longer valid", 409);
      const routing = hints ? await hints({ kind: candidate.kind, siteId: candidate.siteId }).catch(() => ({})) : {};
      return withHint({ ...protocol, job: { jobId: candidate.id, leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString(),
        prompt: isReview ? articleReviewPrompt(articleReviewRequestSchema.parse(context)) : buildContentPrompt(context as Awaited<ReturnType<typeof claimContext>>), outputSchema: isReview ? ARTICLE_REVIEW_OUTPUT_SCHEMA : outputSchema } }, routing);
    } catch (error) {
      await db.contentPlanJob.updateMany({ where: { id: candidate.id, leaseToken, status: "RUNNING" },
        data: { status: "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null, finishedAt: now,
          error: error instanceof ContentError && error.message === PLAN_TOO_LARGE ? PLAN_TOO_LARGE : "Unable to prepare generation context" } });
      throw error;
    }
  }
  const where = leaseWhere(action.jobId, action.leaseToken, now);
  const job = await db.contentPlanJob.findFirst({ where, include: { site: { select: { domain: true } } } });
  if (!job) throw new ContentError("Job lease is no longer valid", 409);
  let result: Prisma.InputJsonValue | undefined;
  if (action.action === "complete") {
    if (job.kind === "ARTICLE_REVIEW") {
      result = finalizeArticleReview(action.result, articleReviewRequestSchema.parse(job.request)) as Prisma.InputJsonValue;
    } else {
    if (!("topics" in action.result)) throw new ContentError("Expected topic plan result");
    if (action.result.topics.length !== job.topicCount) throw new ContentError(`Expected exactly ${job.topicCount} topics`);
    try {
      if (!matchesFunnelCounts(action.result.topics, storedFunnelCounts(job.request, job.topicCount))) throw new ContentError("Generated topics do not match this task's funnel distribution");
      const context = job.context as { allowedInternalLinks?: unknown } | null;
      const verifiedPage = verifiedPageMatcher(Array.isArray(context?.allowedInternalLinks) ? context.allowedInternalLinks.filter((url): url is string => typeof url === "string") : [], job.site.domain);
      // A suggested link outside the verified URL evidence is dropped rather than failing the whole plan;
      // another spelling of a verified page (http, "www.", a trailing slash) takes its verified URL.
      result = { ...action.result, topics: action.result.topics.map((topic) => ({ ...topic, brief: { ...topic.brief,
        internalLinks: topic.brief.internalLinks.flatMap(link => { const target = verifiedPage(link.target); return target ? [{ ...link, target }] : []; }) } })) } as Prisma.InputJsonValue;
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
