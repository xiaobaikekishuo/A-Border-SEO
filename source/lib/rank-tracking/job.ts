import type { Job, PrismaClient } from "@prisma/client";
import { siteMarket } from "@/lib/dataforseo/market";
import { dataForSeoCredentials } from "@/lib/geo/tracking";
import type { DfsCredentials } from "@/lib/geo/dataforseo-ai";
import { DataForSeoError } from "@/lib/geo/dataforseo-parse";
import { isServerless } from "@/lib/jobs/config";
import { isPermanentJobError, JobError, JobLostError, JobReleasedError, type JobContext, type JobHandler } from "@/lib/jobs/types";
import { managedAllowsJob } from "@/lib/managed/policy";
import { checkEstimateUsd } from "./costs";
import { AmbiguousPostError, getTask, hasSearchOperator, POST_BATCH, postTasks, readyTasks, type Device, type PostedTask, type ReadyTask } from "./serp";
import { finishedRunStatus, keywordsWithinBudget, nextCollectDelayMs, ownDomainsOf, RANK_LIMITS, RANK_RETENTION_DAYS, rankSettingsOf } from "./rules";
import { RANK_CHECK_JOB, RANK_COLLECT_JOB } from "./tracking";

/*
 * A rank check run as two kinds of job. RANK_CHECK_JOB creates the run with
 * one check per tracked keyword the budget covers and posts them to
 * DataForSEO's standard queue, 100 per call; that is the only paid step.
 * Before a batch is posted its checks are marked PENDING, so a retry after a
 * crash never posts them again: a batch whose answer was lost is found later
 * in tasks_ready by the tags it was sent with. RANK_COLLECT_JOB then reads
 * the finished tasks of every waiting run of the site and queues itself again
 * while any are still out; a check without a result after COLLECT_WINDOW_MS
 * fails. Reading results is free.
 */

export { RANK_CHECK_JOB, RANK_COLLECT_JOB };

/** The first collector runs this long after posting; DataForSEO's normal queue usually answers within minutes. */
export const FIRST_COLLECT_MS = 2 * 60_000;
/** Checks still without a result this long after posting fail. */
export const COLLECT_WINDOW_MS = 24 * 60 * 60_000;
/** A check not listed as ready is asked for directly only after this long, a few per pass. */
const DIRECT_AFTER_MS = 10 * 60_000;
const DIRECT_PER_PASS = 50;

type SiteRow = { id: string; userId: string; domain: string; researchLanguage: string; researchLocation: number };
type RunRow = {
  id: string; siteId: string; status: string; device: string; depth: number; aiOverview: boolean; language: string; location: number;
  planned: number; budgetUsd: number; startedAt: Date; postedAt: Date | null;
};
const runFields = {
  id: true, siteId: true, status: true, device: true, depth: true, aiOverview: true, language: true, location: true,
  planned: true, budgetUsd: true, startedAt: true, postedAt: true,
} as const;

const prismaCode = (error: unknown) => (error as { code?: string } | null)?.code;
const clip = (text: string) => text.slice(0, 300);

async function siteOf(db: PrismaClient, siteId: string): Promise<SiteRow> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, userId: true, domain: true, researchLanguage: true, researchLocation: true },
  }) as SiteRow | null;
  if (!site) throw new JobError("Site not found", { code: "SITE_NOT_FOUND", permanent: true });
  return site;
}

function permanentFor(error: DataForSeoError): JobError {
  return error.code === "AUTH"
    ? new JobError("DataForSEO refused the saved login. Check it in Settings.", { code: "DATAFORSEO_AUTH", permanent: true })
    : new JobError("The DataForSEO balance is too low. Top it up and run again.", { code: "DATAFORSEO_BALANCE", permanent: true });
}

/* ------------------------------------------------------------------ */
/*  Posting                                                           */
/* ------------------------------------------------------------------ */

async function createRun(db: PrismaClient, job: Job, site: SiteRow): Promise<RunRow> {
  const settings = rankSettingsOf(await db.rankTracking.findUnique({
    where: { siteId: site.id }, select: { device: true, depth: true, aiOverview: true, scheduleDays: true, budgetUsd: true },
  }));
  const keywords = (await db.savedKeyword.findMany({
    where: { siteId: site.id, tracked: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: RANK_LIMITS.tracked, select: { query: true },
  }) as { query: string }[]).map(k => k.query).filter(q => !hasSearchOperator(q));
  if (!keywords.length) throw new JobError("Mark saved keywords for tracking first", { code: "NOTHING_TO_CHECK", permanent: true });
  const fits = keywordsWithinBudget(keywords.length, settings);
  if (!fits) throw new JobError(`The budget of $${settings.budgetUsd.toFixed(2)} does not cover one check`, { code: "BUDGET", permanent: true });
  const market = siteMarket(site);
  try {
    return await db.$transaction(async tx => {
      const run = await tx.rankRun.create({
        data: {
          siteId: site.id, jobId: job.id, source: job.source, status: "POSTING", device: settings.device, depth: settings.depth,
          aiOverview: settings.aiOverview, language: market.language, location: market.location, planned: keywords.length, budgetUsd: settings.budgetUsd,
        },
        select: runFields,
      });
      await tx.rankCheck.createMany({ data: keywords.slice(0, fits).map(keyword => ({ siteId: site.id, runId: run.id, keyword, status: "QUEUED", features: [] })) });
      return run as RunRow;
    });
  } catch (error) {
    // Another attempt of this job created it first.
    if (prismaCode(error) === "P2002") return await db.rankRun.findUniqueOrThrow({ where: { jobId: job.id }, select: runFields }) as RunRow;
    throw error;
  }
}

/** Posts the run's queued checks, a batch at a time, then leaves the run waiting for its results. */
async function postQueued(db: PrismaClient, run: RunRow, credentials: DfsCredentials, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if (!managedAllowsJob(RANK_CHECK_JOB)) throw new JobError("The management policy paused this job.", { code: "MANAGED_RESTRICTED" });
    const batch = await db.rankCheck.findMany({
      where: { runId: run.id, status: "QUEUED" }, orderBy: { id: "asc" }, take: POST_BATCH, select: { id: true, keyword: true },
    }) as { id: string; keyword: string }[];
    if (!batch.length) break;
    const ids = batch.map(b => b.id);
    // Reserved before the paid call: if this process stops after DataForSEO took the batch, no retry posts it again.
    await db.rankCheck.updateMany({ where: { id: { in: ids }, status: "QUEUED" }, data: { status: "PENDING" } });
    let posted: PostedTask[];
    try {
      posted = await postTasks(credentials, batch.map(b => ({
        tag: b.id, keyword: b.keyword, language: run.language, location: run.location,
        device: (run.device === "mobile" ? "mobile" : "desktop") as Device, depth: run.depth, aiOverview: run.aiOverview,
      })), signal);
    } catch (error) {
      // The batch may be at DataForSEO: it stays PENDING and the collector finds it by its tags.
      if (error instanceof AmbiguousPostError) continue;
      if (signal.aborted) throw error;
      // Not taken: back in the queue for the next attempt.
      await db.rankCheck.updateMany({ where: { id: { in: ids }, status: "PENDING", remoteId: null }, data: { status: "QUEUED" } });
      if (error instanceof DataForSeoError && (error.code === "AUTH" || error.code === "BALANCE")) throw permanentFor(error);
      throw error;
    }
    let cost = 0;
    for (const task of posted) {
      if (task.id) {
        cost += task.cost;
        await db.rankCheck.update({ where: { id: task.tag }, data: { remoteId: task.id, costUsd: task.cost } });
      } else {
        await db.rankCheck.update({ where: { id: task.tag }, data: { status: "FAILED", error: clip(task.error ?? "Not posted") } });
      }
    }
    if (cost) await db.rankRun.update({ where: { id: run.id }, data: { costUsd: { increment: cost } } });
  }
  await db.rankRun.update({ where: { id: run.id }, data: { status: "WAITING", postedAt: new Date() } });
}

/**
 * A run no attempt will post further: its unposted checks fail, and it waits
 * for what was posted, or finishes when nothing was.
 */
async function closePosting(db: PrismaClient, runId: string, message: string, code: string): Promise<void> {
  await db.rankCheck.updateMany({ where: { runId, status: "QUEUED" }, data: { status: "FAILED", error: clip(`Not posted: ${message}`) } });
  const pending = await db.rankCheck.count({ where: { runId, status: "PENDING" } }) as number;
  await db.rankRun.updateMany({
    where: { id: runId, status: "POSTING" },
    data: { status: "WAITING", postedAt: new Date(), error: clip(message), errorCode: code },
  });
  if (!pending) await finishRun(db, runId);
}

export async function runRankCheck({ db, job, signal }: JobContext) {
  const site = await siteOf(db, job.siteId);
  const credentials = await dataForSeoCredentials(db, site.userId);
  if (!credentials) throw new JobError("No DataForSEO login is saved", { code: "KEY_MISSING", permanent: true });
  const run = (await db.rankRun.findUnique({ where: { jobId: job.id }, select: runFields }) as RunRow | null) ?? await createRun(db, job, site);
  if (run.status === "POSTING") {
    try {
      await postQueued(db, run, credentials, signal);
    } catch (error) {
      // Shutting down or taken over: a later attempt resumes posting.
      if (signal.aborted || error instanceof JobReleasedError || error instanceof JobLostError) throw error;
      const last = job.attempts >= job.maxAttempts || isPermanentJobError(error) || isServerless();
      if (last) {
        const code = error instanceof JobError && error.code ? error.code : "ERROR";
        try {
          await closePosting(db, run.id, error instanceof Error ? error.message : "Posting failed", code);
          await queueNextCollector(db, site.id, FIRST_COLLECT_MS);
        } catch (cleanup) {
          console.error(`[rank] could not close run ${run.id}:`, cleanup);
        }
      }
      throw error;
    }
  }
  await queueNextCollector(db, site.id, FIRST_COLLECT_MS);
  const state = await db.rankRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true, costUsd: true } }) as { status: string; costUsd: number };
  const posted = await db.rankCheck.count({ where: { runId: run.id, status: "PENDING" } }) as number;
  return { runId: run.id, status: state.status, posted, costUsd: Math.round(state.costUsd * 10000) / 10000 };
}

async function queueNextCollector(db: PrismaClient, siteId: string, delayMs: number) {
  const waiting = await db.rankRun.count({ where: { siteId, status: "WAITING" } }) as number;
  if (!waiting) return;
  const { queueCollector } = await import("./collector");
  await queueCollector(db, siteId, delayMs);
}

/* ------------------------------------------------------------------ */
/*  Collecting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Closes a run with its counts read from its checks. Keywords the budget left
 * out count as planned and not checked, and say so.
 */
export async function finishRun(db: PrismaClient, runId: string): Promise<void> {
  const run = await db.rankRun.findUnique({ where: { id: runId }, select: { siteId: true, planned: true, budgetUsd: true, error: true, errorCode: true } }) as
    { siteId: string; planned: number; budgetUsd: number; error: string | null; errorCode: string | null } | null;
  if (!run) return;
  const counts = await db.rankCheck.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
  const count = (status: string) => counts.find(c => c.status === status)?._count._all ?? 0;
  const ok = count("OK"), failed = count("FAILED");
  const checks = counts.reduce((sum, c) => sum + c._count._all, 0);
  const skipped = Math.max(0, run.planned - checks);
  const budget = skipped > 0 && !run.errorCode
    ? { error: `Checked ${checks} of ${run.planned} keywords: the budget of $${run.budgetUsd.toFixed(2)} per run covers no more.`, errorCode: "BUDGET" }
    : {};
  await db.rankRun.update({
    where: { id: runId },
    data: { status: finishedRunStatus(run.planned, ok, failed), done: ok + failed, failed, finishedAt: new Date(), ...budget },
  });
  await db.rankRun.deleteMany({ where: { siteId: run.siteId, startedAt: { lt: new Date(Date.now() - RANK_RETENTION_DAYS * 86_400_000) } } });
}

async function collectRun(db: PrismaClient, run: RunRow, ready: ReadyTask[], credentials: DfsCredentials, ownDomains: string[], signal: AbortSignal): Promise<boolean> {
  const readyIds = new Set(ready.map(r => r.id));
  const byTag = new Map(ready.flatMap(r => (r.tag ? [[r.tag, r.id] as const] : [])));
  const sincePosted = Date.now() - (run.postedAt ?? run.startedAt).getTime();
  const pending = await db.rankCheck.findMany({
    where: { runId: run.id, status: "PENDING" }, orderBy: { id: "asc" }, select: { id: true, remoteId: true },
  }) as { id: string; remoteId: string | null }[];
  let direct = 0;
  for (const check of pending) {
    signal.throwIfAborted();
    // A check whose post went unanswered is known only by its tag, once its task is ready.
    const remoteId = check.remoteId ?? byTag.get(check.id) ?? null;
    if (!remoteId) continue;
    const listed = readyIds.has(remoteId);
    if (!listed && (sincePosted < DIRECT_AFTER_MS || direct >= DIRECT_PER_PASS)) continue;
    if (!listed) direct++;
    const outcome = await getTask(credentials, remoteId, ownDomains, run.aiOverview, signal);
    // Found by its tag: it was posted and paid, at about the estimate.
    const adopted = !check.remoteId ? { remoteId, costUsd: checkEstimateUsd(run.depth, run.aiOverview) } : {};
    if (outcome.state === "PENDING") {
      if (!check.remoteId) await db.rankCheck.update({ where: { id: check.id }, data: { remoteId } });
      continue;
    }
    if (outcome.state === "FAILED") {
      await db.rankCheck.update({ where: { id: check.id }, data: { status: "FAILED", error: clip(outcome.error), ...adopted } });
    } else {
      const r = outcome.reading;
      await db.rankCheck.update({
        where: { id: check.id },
        data: {
          status: "OK", position: r.position, absolute: r.absolute, url: r.url, aiOverview: r.aiOverview, aiCited: r.aiCited,
          features: r.features, top: r.top, checkedAt: r.checkedAt ?? new Date(), error: null, ...adopted,
        },
      });
    }
    if ("costUsd" in adopted) await db.rankRun.update({ where: { id: run.id }, data: { costUsd: { increment: adopted.costUsd } } });
  }
  const left = await db.rankCheck.count({ where: { runId: run.id, status: { in: ["PENDING", "QUEUED"] } } }) as number;
  if (left && sincePosted < COLLECT_WINDOW_MS) {
    const counts = await db.rankCheck.groupBy({ by: ["status"], where: { runId: run.id, status: { in: ["OK", "FAILED"] } }, _count: { _all: true } });
    const done = counts.reduce((sum, c) => sum + c._count._all, 0);
    const failed = counts.find(c => c.status === "FAILED")?._count._all ?? 0;
    await db.rankRun.update({ where: { id: run.id }, data: { done, failed } });
    return false;
  }
  if (left) {
    await db.rankCheck.updateMany({
      where: { runId: run.id, status: { in: ["PENDING", "QUEUED"] } },
      data: { status: "FAILED", error: "DataForSEO returned no result within 24 hours" },
    });
  }
  await finishRun(db, run.id);
  return true;
}

export async function runRankCollect({ db, job, signal }: JobContext) {
  const site = await siteOf(db, job.siteId);
  const runs = await db.rankRun.findMany({ where: { siteId: site.id, status: "WAITING" }, orderBy: { startedAt: "asc" }, select: runFields }) as RunRow[];
  if (!runs.length) return { waiting: 0, finished: 0 };
  const credentials = await dataForSeoCredentials(db, site.userId);
  if (!credentials) {
    // The login was removed: nothing can be read any more.
    for (const run of runs) {
      await db.rankCheck.updateMany({ where: { runId: run.id, status: { in: ["PENDING", "QUEUED"] } }, data: { status: "FAILED", error: "The DataForSEO login was removed" } });
      await finishRun(db, run.id);
    }
    return { waiting: 0, finished: runs.length };
  }
  if (!managedAllowsJob(RANK_COLLECT_JOB)) throw new JobError("The management policy paused this job.", { code: "MANAGED_RESTRICTED" });
  let ready: ReadyTask[];
  try {
    ready = await readyTasks(credentials, signal);
  } catch (error) {
    if (error instanceof DataForSeoError && error.code === "AUTH") throw permanentFor(error);
    throw error;
  }
  const ownDomains = ownDomainsOf(site.domain);
  let finished = 0;
  for (const run of runs) {
    if (await collectRun(db, run, ready, credentials, ownDomains, signal)) finished++;
  }
  const waiting = runs.length - finished;
  if (waiting) {
    const oldest = Math.min(...runs.map(r => (r.postedAt ?? r.startedAt).getTime()));
    const { queueCollector } = await import("./collector");
    await queueCollector(db, site.id, nextCollectDelayMs(Date.now() - oldest));
  }
  return { waiting, finished };
}

export const rankCheckHandler: JobHandler = {
  type: RANK_CHECK_JOB,
  class: "SHORT",
  maxAttempts: 3,
  isPermanent: isPermanentJobError,
  stopOnShutdown: true,
  run: runRankCheck,
  async onInterrupted(db, job) {
    // Recovery has already decided: a job queued again resumes posting; otherwise close the run.
    const current = await db.job.findUnique({ where: { id: job.id }, select: { status: true } }) as { status: string } | null;
    if (current?.status === "QUEUED") return;
    const run = await db.rankRun.findUnique({ where: { jobId: job.id }, select: { id: true, status: true } }) as { id: string; status: string } | null;
    if (run?.status === "POSTING") await closePosting(db, run.id, "Interrupted", "INTERRUPTED");
  },
};

export const rankCollectHandler: JobHandler = {
  type: RANK_COLLECT_JOB,
  class: "SHORT",
  maxAttempts: 5,
  isPermanent: isPermanentJobError,
  run: runRankCollect,
  // A finished run can fire the rank drop alert. ALERTS_EVALUATE_JOB of lib/jobs/handlers.ts, which imports this module.
  followUps: (_job, result) => ((result as { finished?: number } | undefined)?.finished ? ["alerts-evaluate"] : []),
};
