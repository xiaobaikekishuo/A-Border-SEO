import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { isResearchLanguage } from "@/lib/dataforseo/market";
import { managedAllows } from "@/lib/managed/policy";
import { managedSiteAllows } from "@/lib/managed/worker-owner";
import { buildWorkbenchContext } from "../data";
import { reportJobContext } from "../report-context";
import { buildReportWorkerClaim } from "../report-claim";
import { workbenchRequestSchema, type WorkbenchRequest } from "../schema";
import { assertToolRequest } from "../tools";
import { capOf, fillDueSites } from "./fill";
import { PoolSkip, poolServerEnabled, requestForItem, skipReasonOf } from "./items";
import { poolPolicy, storedLimits, storedModels, type WorkerLimits } from "./limits";
import { routingFrom, routingHint, type RoutingHint } from "./routing";

/*
 * The background pool at work. A 1.9.0 worker reports its Codex allowance
 * every few minutes (recordWorkerLimits). When it asks for work and nothing
 * is queued, queuePoolJob fills the pools that are due, then turns the most
 * urgent waiting item of a site with no active task into a workbench task,
 * if the owner's reserves, review cap and the site's daily cap allow. The
 * item is taken first, so an item that cannot become a task is skipped, not
 * tried again on every poll.
 */

type Db = PrismaClient;
export type WorkerState = { limits: unknown; limitsAt: Date | null; models: unknown; capabilities: string[] } | null;

/** The id of a worker's ContentWorkerState row: its own id, or its desktop's on a hosted server. */
export function workerStateId(workerId: string, hosted: { deviceId: string } | null | undefined): string {
  return hosted ? `hosted:${hosted.deviceId}` : workerId;
}

export async function recordWorkerLimits(db: Db, id: string, input: { limits: WorkerLimits | null; error: string | null; models?: unknown[]; capabilities?: string[] }, now: Date) {
  const data = {
    lastSeenAt: now, limitsAt: now, limitsError: input.error,
    limits: input.limits ? input.limits as Prisma.InputJsonValue : Prisma.DbNull,
    ...(input.models ? { models: input.models as Prisma.InputJsonValue } : {}),
    capabilities: input.capabilities ?? [],
  };
  await db.contentWorkerState.upsert({ where: { id }, create: { id, ...data }, update: data });
}

/** Per-task model and reasoning hints for a worker that takes them, from each task owner's settings. */
export function claimHints(db: Pick<PrismaClient, "site">, worker: WorkerState) {
  if (!worker?.capabilities?.includes("routing-v1")) return undefined;
  const models = storedModels(worker.models);
  return async ({ kind, siteId }: { kind: string; siteId: string }): Promise<RoutingHint> => {
    const site = await db.site.findUnique({ where: { id: siteId }, select: { user: { select: { aiPoolSetting: {
      select: { lightModel: true, lightReasoning: true, mainModel: true, mainReasoning: true } } } } } });
    return routingHint(kind, routingFrom(site?.user.aiPoolSetting ?? null), models);
  };
}

/** A workbench task for a pool item, inside the caller's transaction. */
export async function createPoolJob(tx: Prisma.TransactionClient, site: { id: string; domain: string }, input: WorkbenchRequest, deviceId: string | null, now: Date): Promise<string> {
  const jobId = `aw_${randomUUID()}`;
  let request = input;
  let context: unknown;
  if (input.actionScope) {
    const built = await reportJobContext(tx, site, input.actionScope, now);
    request = workbenchRequestSchema.parse({ ...input, evidenceRevision: built.evidenceRevision });
    context = built.context;
    // Throws when the report does not fit a worker claim.
    buildReportWorkerClaim(request, built.context.reportEvidence, { jobId, leaseToken: "0".repeat(36), leaseExpiresAt: now.toISOString() });
  } else {
    assertToolRequest(request);
    context = await buildWorkbenchContext(tx, site, request, now);
  }
  await tx.aiWorkbenchJob.create({ data: { id: jobId, siteId: site.id, hostedDeviceId: deviceId, kind: request.kind, title: request.title,
    request: request as Prisma.InputJsonValue, context: context as Prisma.InputJsonValue, activeKey: site.id, createdAt: now, updatedAt: now } });
  return jobId;
}

type Setting = { userId: string; shortReserve: number; weeklyReserve: number; reviewCap: number; language: string };

/** Background results that finished and are not marked as reviewed. */
export function waitingReview(db: Pick<PrismaClient, "aiBacklogItem">, userId: string) {
  return db.aiBacklogItem.count({ where: { status: "STARTED", reviewedAt: null, job: { status: "SUCCEEDED" }, site: { userId } } });
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Creates the next background task the worker may run and returns its id,
 * or null. `owner`: the worker's owner (hosted or managed); null on a
 * single-owner install. `worker`: the claiming worker's state row.
 */
export async function queuePoolJob(db: Db, owner: { userId: string | null }, deviceId: string | null, worker: WorkerState, now = new Date()): Promise<string | null> {
  if (!poolServerEnabled() || !managedAllows("codex")) return null;
  const settings: Setting[] = await db.aiPoolSetting.findMany({ where: { enabled: true, ...(owner.userId ? { userId: owner.userId } : {}) },
    select: { userId: true, shortReserve: true, weeklyReserve: true, reviewCap: true, language: true } });
  if (!settings.length) return null;
  try { await fillDueSites(db, owner, now); } catch (error) { console.error("[pool] fill failed:", error instanceof Error ? error.message : error); }

  const limits = storedLimits(worker?.limits);
  const allowed = new Map<string, boolean>();
  for (const setting of settings) {
    const policy = poolPolicy(limits, worker?.limitsAt ?? null, now, setting);
    allowed.set(setting.userId, policy.ok && await waitingReview(db, setting.userId) < setting.reviewCap);
  }
  const users = [...allowed].filter(([, ok]) => ok).map(([userId]) => userId);
  if (!users.length) return null;

  const candidates = await db.aiBacklogItem.findMany({
    where: { status: "PENDING", site: { userId: { in: users }, aiWorkbenchJobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } } } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 20,
    select: { id: true, siteId: true, source: true, kind: true, title: true, payload: true, site: { select: { userId: true, aiAutomation: {
      select: { rankingsCap: true, alertsCap: true, metaCap: true, schemaCap: true, clustersCap: true, briefsCap: true } } } } },
  });
  const today = utcDayStart(now);
  const startedToday = new Map<string, number>();
  for (const item of candidates) {
    const cap = capOf(item.source, item.site.aiAutomation);
    if (cap !== null) {
      // Each kind of automatic task has its own daily limit per site.
      const key = `${item.siteId}:${item.source}`;
      if (!startedToday.has(key)) {
        startedToday.set(key, await db.aiBacklogItem.count({ where: { siteId: item.siteId, source: item.source, status: "STARTED", startedAt: { gte: today } } }));
      }
      if (startedToday.get(key)! >= cap) continue;
    }
    if (!await managedSiteAllows(db, item.siteId)) continue;
    const setting = settings.find(entry => entry.userId === item.site.userId)!;
    return startItem(db, item, isResearchLanguage(setting.language) ? setting.language : "zh-CN", deviceId, now);
  }
  return null;
}

async function startItem(db: Db, item: { id: string; siteId: string; kind: string; title: string; payload: unknown }, language: string, deviceId: string | null, now: Date): Promise<string | null> {
  const taken = await db.aiBacklogItem.updateMany({ where: { id: item.id, status: "PENDING" }, data: { status: "STARTED", startedAt: now, reason: null } });
  if (!taken.count) return null;
  try {
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${item.siteId} FOR UPDATE`;
      if (await tx.aiWorkbenchJob.count({ where: { siteId: item.siteId, status: { in: ["QUEUED", "RUNNING"] } } })) {
        // The site got busy meanwhile: the item waits for the next turn.
        await tx.aiBacklogItem.update({ where: { id: item.id }, data: { status: "PENDING", startedAt: null } });
        return null;
      }
      const site = await tx.site.findUniqueOrThrow({ where: { id: item.siteId }, select: { id: true, domain: true } });
      const request = await requestForItem(tx, site, item, language);
      const jobId = await createPoolJob(tx, site, request, deviceId, now);
      await tx.aiBacklogItem.update({ where: { id: item.id }, data: { jobId } });
      return jobId;
    }, { timeout: 20000 });
  } catch (error) {
    const reason = error instanceof PoolSkip ? error.reason : error instanceof ContentError ? skipReasonOf(error.message) : "prepare_failed";
    if (!(error instanceof PoolSkip) && !(error instanceof ContentError)) console.error("[pool] task not created:", error instanceof Error ? error.message : error);
    await db.aiBacklogItem.updateMany({ where: { id: item.id, status: "STARTED", jobId: null }, data: { status: "SKIPPED", reason } }).catch(() => {});
    return null;
  }
}
