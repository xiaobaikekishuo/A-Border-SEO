import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { paidConfirmation } from "@/lib/dataforseo/confirmation";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { activeTrackingJob, GEO_TRIAL_JOB, GEO_VISIBILITY_JOB, runPlan } from "@/lib/geo/tracking";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { recoverStaleJobs } from "@/lib/jobs/queue";
import { requestSiteJob } from "@/lib/jobs/site-jobs";

export const runtime = "nodejs";
// On a serverless host the run works after the response, within this limit
// (SERVERLESS_MAX_DURATION_S in lib/jobs/config.ts; Next needs a literal here).
export const maxDuration = 300;

/**
 * Starts a tracking run: every active prompt on every chosen platform, paid
 * through the user's DataForSEO account. With `trial: true`, only the first
 * active prompt on each platform: the cheap way to check the setup. The body
 * confirms the cost: {provider: "dataforseo", confirmed: true, operations:
 * <tasks>, language, location, trial?}. Answers 202 with the job id; GET
 * /api/jobs/[jobId] follows it. One run at a time per site: while a run or a
 * trial is queued or running, that one is returned (`alreadyActive`).
 */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const body = await req.clone().json().catch(() => null) as { trial?: unknown } | null;
    const trial = body?.trial === true;
    const plan = await runPlan(db, userId, siteId, { trial });
    const denied = await paidConfirmation(req, plan.market, plan.tasks);
    if (denied) {
      denied.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      return denied;
    }
    const answer = { tasks: plan.tasks, estimateUsd: plan.usd, budgetUsd: plan.settings.budgetUsd, trial };
    await recoverStaleJobs(db, { siteId });
    const active = await activeTrackingJob(db, siteId);
    if (active && active.trial !== trial) {
      // The other kind is queued or running: nothing new starts and nothing is charged.
      return Response.json({ jobId: active.jobId, status: active.status, ...answer, trial: active.trial, alreadyActive: true }, { status: 202, headers: NO_STORE });
    }
    const { job, created } = await requestSiteJob(db, { type: trial ? GEO_TRIAL_JOB : GEO_VISIBILITY_JOB, siteId, source: "manual" });
    dispatchJob(db, job);
    return Response.json({ jobId: job.id, status: job.status, ...answer, ...(!created && { alreadyActive: true }) }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
