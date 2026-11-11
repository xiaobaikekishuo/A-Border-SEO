import type { Job, PrismaClient } from "@prisma/client";
import { siteMarket, type ResearchMarket } from "@/lib/dataforseo/market";
import { isServerless } from "@/lib/jobs/config";
import { isPermanentJobError, JobError, JobLostError, JobReleasedError, type JobContext, type JobHandler } from "@/lib/jobs/types";
import { askPlatform, claudeModels, pickClaudeModel, TASK_ESTIMATE_USD, TASK_TIMEOUT_MS, type AskResult, type DfsCredentials } from "./dataforseo-ai";
import { DataForSeoError } from "./dataforseo-parse";
import { isGeoPlatformId, TRACKED_PLATFORMS, type GeoPlatformId } from "./platforms";
import {
  compactSummary, dataForSeoCredentials, GEO_TRIAL_JOB, GEO_VISIBILITY_JOB, settingsOf, summarizeByPlatform, TRACKING_LIMITS, type AnswerMeta,
} from "./tracking";

/*
 * A tracking run as a job: every active prompt on every chosen platform, a
 * few tasks at a time. Each answer is saved as it arrives, so a retry of the
 * job (after a restart, say) resumes the same run and skips what is done.
 * The run stops starting tasks once the next one could take it over its
 * budget, and stops entirely when DataForSEO refuses the login or the balance.
 * A prompt deleted during the run is dropped from it. A trial (GEO_TRIAL_JOB)
 * is the same run with only the first active prompt.
 */

export { GEO_TRIAL_JOB, GEO_VISIBILITY_JOB };

const CONCURRENCY = 4;
const RETRY_DELAYS_MS = [5_000, 20_000];
/** Runs, and the answers they fetched, are kept this long. Recorded answers stay. */
export const RUN_RETENTION_DAYS = 400;

type Plan = { prompts: string[]; platforms: GeoPlatformId[]; market: ResearchMarket; claudeModel: string | null; trial: boolean };
type RunState = { id: string; status: string; planned: number; done: number; failed: number; costUsd: number; budgetUsd: number; plan: unknown };
type SiteRow = { id: string; userId: string; domain: string; researchLanguage: string; researchLocation: number };
type Stop = { status: "PARTIAL" | "FAILED"; message: string; code: string };
type RunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

const trackingFields = { brands: true, platforms: true, scheduleDays: true, budgetUsd: true } as const;

function readPlan(value: unknown): Plan {
  const plan = (value ?? {}) as Partial<Plan>;
  return {
    prompts: Array.isArray(plan.prompts) ? plan.prompts.filter((p): p is string => typeof p === "string") : [],
    platforms: Array.isArray(plan.platforms) ? plan.platforms.filter((p): p is GeoPlatformId => isGeoPlatformId(p) && TRACKED_PLATFORMS.includes(p)) : [],
    market: plan.market ?? { language: "en", location: 2840 },
    claudeModel: typeof plan.claudeModel === "string" ? plan.claudeModel : null,
    trial: plan.trial === true,
  };
}

const prismaCode = (error: unknown) => (error as { code?: string } | null)?.code;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
});

/** A task answered, with up to two more attempts for errors a retry can fix. */
export async function askWithRetry(ask: () => Promise<AskResult>, signal: AbortSignal, delays: readonly number[] = RETRY_DELAYS_MS): Promise<AskResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ask();
    } catch (error) {
      if (signal.aborted || !(error instanceof DataForSeoError) || !error.retryable || attempt >= delays.length) throw error;
      await sleep(delays[attempt], signal);
    }
  }
}

/** The status a finished run gets from what it holds. */
export function runStatus(planned: number, done: number, failed: number): RunStatus {
  if (done === 0 || failed === done) return "FAILED";
  return failed === 0 && done >= planned ? "SUCCEEDED" : "PARTIAL";
}

async function createRun(db: PrismaClient, job: Job, site: SiteRow, credentials: DfsCredentials, signal: AbortSignal): Promise<RunState> {
  const settings = settingsOf(await db.geoTracking.findUnique({ where: { siteId: site.id }, select: trackingFields }), site.domain);
  if (!settings) throw new JobError("Prompt tracking is not set up for this site", { code: "NOT_CONFIGURED", permanent: true });
  const trial = job.type === GEO_TRIAL_JOB;
  const prompts = await db.geoPrompt.findMany({
    where: { siteId: site.id, active: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: trial ? 1 : TRACKING_LIMITS.activePrompts, select: { id: true },
  }) as { id: string }[];
  if (!prompts.length || !settings.platforms.length) throw new JobError("Add active prompts and choose platforms first", { code: "NOTHING_TO_ASK", permanent: true });
  let claudeModel: string | null = null;
  if (settings.platforms.includes("CLAUDE")) {
    try { claudeModel = pickClaudeModel(await claudeModels(credentials, signal)); }
    catch (error) {
      if (error instanceof DataForSeoError && (error.code === "AUTH" || error.code === "BALANCE")) throw error;
      if (signal.aborted) throw error;
      // The Claude tasks fail on their own; the other platforms still run.
    }
  }
  const plan: Plan = { prompts: prompts.map(p => p.id), platforms: settings.platforms, market: siteMarket(site), claudeModel, trial };
  try {
    return await db.geoRun.create({
      data: { siteId: site.id, jobId: job.id, source: job.source, status: "RUNNING", plan, planned: prompts.length * settings.platforms.length, budgetUsd: settings.budgetUsd },
    }) as RunState;
  } catch (error) {
    // Another attempt of this job created it first.
    if (prismaCode(error) === "P2002") return await db.geoRun.findUniqueOrThrow({ where: { jobId: job.id } }) as RunState;
    throw error;
  }
}

function permanentFor(error: DataForSeoError): JobError {
  return error.code === "AUTH"
    ? new JobError("DataForSEO refused the saved login. Check it in Settings.", { code: "DATAFORSEO_AUTH", permanent: true })
    : new JobError("The DataForSEO balance is too low. Top it up and run again.", { code: "DATAFORSEO_BALANCE", permanent: true });
}

/**
 * Closes the run with counts recomputed from its answers (the live counters
 * only show progress, and a deleted prompt takes its answers with it), keeps
 * the summary for the trend, and prunes runs past RUN_RETENTION_DAYS. The cost
 * stays as counted: what DataForSEO charged is spent either way.
 */
async function finishRun(db: PrismaClient, runId: string, plan: Plan, site: SiteRow, stop: Stop | null) {
  const [answers, record, remaining] = await Promise.all([
    db.geoAnswer.findMany({ where: { runId }, select: { id: true, promptId: true, platform: true, source: true, status: true, text: true, citations: true, error: true, createdAt: true } }),
    db.geoTracking.findUnique({ where: { siteId: site.id }, select: trackingFields }),
    db.geoPrompt.count({ where: { id: { in: plan.prompts }, siteId: site.id } }),
  ]) as [{ status: string; id: string; promptId: string; platform: string; source: string; text: string | null; citations: unknown; error: string | null; createdAt: Date }[], Parameters<typeof settingsOf>[0], number];
  const planned = remaining * plan.platforms.length;
  const done = answers.length;
  const failed = answers.filter(a => a.status === "FAILED").length;
  const status = stop?.status ?? runStatus(planned, done, failed);
  const brands = settingsOf(record, site.domain)?.brands;
  const summary = brands ? compactSummary(summarizeByPlatform(answers, brands)) : null;
  await db.geoRun.update({
    where: { id: runId },
    data: { status, planned, done, failed, summary: summary ?? undefined, finishedAt: new Date(), error: stop?.message ?? null, errorCode: stop?.code ?? null },
  });
  await db.geoRun.deleteMany({ where: { siteId: site.id, startedAt: { lt: new Date(Date.now() - RUN_RETENTION_DAYS * 86_400_000) } } });
  return { status, planned, done, failed };
}

export async function runVisibility({ db, job, signal, deadline }: JobContext) {
  const site = await db.site.findUnique({ where: { id: job.siteId }, select: { id: true, userId: true, domain: true, researchLanguage: true, researchLocation: true } }) as SiteRow | null;
  if (!site) throw new JobError("Site not found", { code: "SITE_NOT_FOUND", permanent: true });
  const credentials = await dataForSeoCredentials(db, site.userId);
  if (!credentials) throw new JobError("No DataForSEO login is saved", { code: "KEY_MISSING", permanent: true });

  let run = await db.geoRun.findUnique({ where: { jobId: job.id } }) as RunState | null;
  try {
    run ??= await createRun(db, job, site, credentials, signal);
  } catch (error) {
    if (error instanceof DataForSeoError) throw permanentFor(error);
    throw error;
  }
  if (run.status !== "RUNNING") return { runId: run.id, status: run.status };
  const runId = run.id;
  const plan = readPlan(run.plan);

  try {
    return await executeRun(db, run, plan, site, credentials, signal, deadline);
  } catch (error) {
    // Shutting down or taken over: the job is released and a later attempt resumes the run.
    if (signal.aborted || error instanceof JobReleasedError || error instanceof JobLostError) throw error;
    // No attempt will resume this run (last attempt, a permanent error, or a serverless host): close it.
    const last = job.attempts >= job.maxAttempts || isPermanentJobError(error) || isServerless();
    const open = last && (await db.geoRun.findUnique({ where: { id: runId }, select: { status: true } }) as { status: string } | null)?.status === "RUNNING";
    if (open) {
      const stop: Stop = error instanceof JobError && error.code?.startsWith("DATAFORSEO_")
        ? { status: "PARTIAL", message: error.message, code: error.code }
        : { status: "PARTIAL", message: error instanceof Error ? error.message.slice(0, 300) : "The run failed", code: "ERROR" };
      try {
        const closed = await finishRun(db, runId, plan, site, stop);
        if (closed.done === closed.failed) await db.geoRun.update({ where: { id: runId }, data: { status: "FAILED" } });
      } catch (cleanup) {
        console.error(`[geo] could not close tracking run ${runId}:`, cleanup);
      }
    }
    throw error;
  }
}

async function executeRun(db: PrismaClient, run: RunState, plan: Plan, site: SiteRow, credentials: DfsCredentials, signal: AbortSignal, deadline: number | undefined) {
  const runId = run.id;
  const budget = run.budgetUsd;
  const prompts = new Map((await db.geoPrompt.findMany({ where: { id: { in: plan.prompts }, siteId: site.id }, select: { id: true, text: true } }) as { id: string; text: string }[]).map(p => [p.id, p.text]));
  const done = new Set((await db.geoAnswer.findMany({ where: { runId }, select: { promptId: true, platform: true } }) as { promptId: string; platform: string }[]).map(a => `${a.promptId}\0${a.platform}`));
  const ownDomains = settingsOf(await db.geoTracking.findUnique({ where: { siteId: site.id }, select: trackingFields }), site.domain)?.brands.own.domains ?? [site.domain];
  // Prompts in the plan order, each on every platform: one prompt's answers arrive together.
  // Prompts deleted since the run started are dropped.
  const tasks = plan.prompts.filter(id => prompts.has(id))
    .flatMap(promptId => plan.platforms.map(platform => ({ promptId, platform })))
    .filter(t => !done.has(`${t.promptId}\0${t.platform}`));

  let cost = run.costUsd;
  // Written by the workers; an object, so the checks after them see the writes.
  const outcome: { stopped: Stop | null; fatal: JobError | null; crash: unknown } = { stopped: null, fatal: null, crash: null };
  let next = 0;

  const save = async (promptId: string, platform: GeoPlatformId, data: { status: "OK" | "NO_ANSWER" | "FAILED"; text?: string; citations?: unknown; meta?: AnswerMeta; costUsd?: number; error?: string }) => {
    try {
      await db.geoAnswer.create({
        data: {
          siteId: site.id, runId, promptId, platform, source: "DATAFORSEO", status: data.status, text: data.text || null,
          citations: data.citations ?? [], meta: data.meta ?? undefined, costUsd: data.costUsd ?? 0, error: data.error ?? null,
        },
      });
    } catch (error) {
      // Saved by another attempt, or the prompt was deleted meanwhile: only the cost still counts.
      const code = prismaCode(error);
      if (code !== "P2002" && code !== "P2003") throw error;
      if (code === "P2003" && data.costUsd) await db.geoRun.update({ where: { id: runId }, data: { costUsd: { increment: data.costUsd } } });
      return;
    }
    await db.geoRun.update({
      where: { id: runId },
      data: { done: { increment: 1 }, ...(data.status === "FAILED" && { failed: { increment: 1 } }), costUsd: { increment: data.costUsd ?? 0 } },
    });
  };

  const worker = async () => {
    try {
      while (!outcome.stopped && !outcome.fatal && !outcome.crash && !signal.aborted && next < tasks.length) {
        const { promptId, platform } = tasks[next];
        if (deadline !== undefined && Date.now() > deadline - TASK_TIMEOUT_MS - 10_000) {
          outcome.stopped ??= { status: "PARTIAL", message: "Stopped at the time limit of this host. Run again to finish.", code: "TIME_LIMIT" };
          break;
        }
        const estimate = TASK_ESTIMATE_USD[platform] ?? 0;
        if (cost + estimate > budget + 1e-9) {
          outcome.stopped ??= { status: "PARTIAL", message: `Stopped at the budget of $${budget.toFixed(2)} per run.`, code: "BUDGET" };
          break;
        }
        next++;
        const prompt = prompts.get(promptId)!;
        cost += estimate; // reserved until the real cost is known
        let answer: AskResult;
        try {
          answer = await askWithRetry(
            () => askPlatform(credentials, { platform, prompt, market: plan.market, ownDomains, claudeModel: plan.claudeModel }, signal),
            signal,
          );
        } catch (error) {
          cost -= estimate;
          if (signal.aborted) break;
          if (error instanceof DataForSeoError && (error.code === "AUTH" || error.code === "BALANCE")) {
            outcome.fatal ??= permanentFor(error);
            break;
          }
          await save(promptId, platform, { status: "FAILED", error: error instanceof Error ? error.message.slice(0, 300) : "Request failed" });
          continue;
        }
        cost += answer.cost - estimate;
        await save(promptId, platform, {
          status: answer.status, text: answer.text, citations: answer.citations, costUsd: answer.cost,
          meta: { model: answer.model, consulted: answer.consulted, fanOut: answer.fanOut, ...(answer.organicRank !== undefined && { organicRank: answer.organicRank }) },
        });
      }
    } catch (error) {
      // Stop the other workers too: a retry of the job resumes, and must not pay for the same tasks twice.
      outcome.crash ??= error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, tasks.length)) }, worker));
  signal.throwIfAborted();
  if (outcome.crash) throw outcome.crash;

  const { stopped, fatal } = outcome;
  if (fatal) {
    const closed = await finishRun(db, runId, plan, site, { status: "PARTIAL", message: fatal.message, code: fatal.code ?? "DATAFORSEO" });
    if (closed.done === closed.failed) await db.geoRun.update({ where: { id: runId }, data: { status: "FAILED" } });
    throw fatal;
  }
  const closed = await finishRun(db, runId, plan, site, stopped);
  const state = await db.geoRun.findUniqueOrThrow({ where: { id: runId }, select: { costUsd: true } }) as { costUsd: number };
  return { runId, ...closed, costUsd: Math.round(state.costUsd * 10000) / 10000 };
}

export const geoVisibilityHandler: JobHandler = {
  type: GEO_VISIBILITY_JOB,
  class: "LONG",
  maxAttempts: 3,
  isPermanent: isPermanentJobError,
  stopOnShutdown: true,
  run: runVisibility,
  async onInterrupted(db, job) {
    // Recovery has already decided: a job queued again resumes the run; otherwise close it.
    const current = await db.job.findUnique({ where: { id: job.id }, select: { status: true } }) as { status: string } | null;
    if (current?.status === "QUEUED") return;
    await db.geoRun.updateMany({
      where: { jobId: job.id, status: "RUNNING" },
      data: { status: "PARTIAL", finishedAt: new Date(), error: "Interrupted", errorCode: "INTERRUPTED" },
    });
  },
};

/** A trial run: the same work for the first active prompt only, never scheduled. */
export const geoTrialHandler: JobHandler = { ...geoVisibilityHandler, type: GEO_TRIAL_JOB };
