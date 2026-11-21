import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { paidConfirmation } from "@/lib/dataforseo/confirmation";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { recoverStaleJobs } from "@/lib/jobs/queue";
import { requestSiteJob } from "@/lib/jobs/site-jobs";
import { activeRankJob, RANK_CHECK_JOB, rankRunPlan } from "@/lib/rank-tracking/tracking";

export const runtime = "nodejs";
const RANK_FAILED = "The rank tracking request failed";
// On a serverless host the posting runs after the response, within this limit
// (SERVERLESS_MAX_DURATION_S in lib/jobs/config.ts; Next needs a literal here).
export const maxDuration = 300;

/**
 * Starts a rank check run: every tracked keyword the run's budget covers,
 * posted to DataForSEO's standard queue and paid through the user's own
 * DataForSEO account. The body confirms the cost: {provider: "dataforseo",
 * confirmed: true, operations: <checks>, language, location}. Answers 202
 * with the job id. One posting at a time per site: while one is queued or
 * running, that one is returned (`alreadyActive`). The results arrive over
 * the next minutes; GET /api/sites/[siteId]/rank-tracking shows them.
 */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const plan = await rankRunPlan(db, userId, siteId);
    const denied = await paidConfirmation(req, plan.market, plan.tasks);
    if (denied) {
      denied.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      return denied;
    }
    const answer = { tasks: plan.tasks, estimateUsd: plan.usd, skipped: plan.skipped, budgetUsd: plan.settings.budgetUsd };
    await recoverStaleJobs(db, { siteId });
    const active = await activeRankJob(db, siteId);
    if (active) return Response.json({ jobId: active.jobId, status: active.status, ...answer, alreadyActive: true }, { status: 202, headers: NO_STORE });
    const { job, created } = await requestSiteJob(db, { type: RANK_CHECK_JOB, siteId, source: "manual" });
    dispatchJob(db, job);
    return Response.json({ jobId: job.id, status: job.status, ...answer, ...(!created && { alreadyActive: true }) }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}
