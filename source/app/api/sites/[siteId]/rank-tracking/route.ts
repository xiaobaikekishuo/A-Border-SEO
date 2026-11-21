import { auth } from "@/lib/auth";
import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { ensureCollector } from "@/lib/rank-tracking/collector";
import { readRankProgress, readRankWorkspace, saveRankSettings } from "@/lib/rank-tracking/tracking";

export const runtime = "nodejs";
const RANK_FAILED = "The rank tracking request failed";
// On a serverless host a due collector runs after the response, within this limit
// (SERVERLESS_MAX_DURATION_S in lib/jobs/config.ts; Next needs a literal here).
export const maxDuration = 300;

/**
 * Rank tracking: settings, the saved keywords with their latest measured
 * position, and recent runs. ?view=progress answers only the active job and
 * the runs, for polling while a run is going. While a run waits for its
 * results, a read also makes sure a collector is queued and runs it when due.
 */
export async function GET(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const progress = new URL(req.url).searchParams.get("view") === "progress";
    const body = progress ? await readRankProgress(db, userId, siteId) : await readRankWorkspace(db, userId, siteId);
    await ensureCollector(db, siteId).catch(error => console.error("[rank] could not queue a collector:", error));
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}

/** Saves device, depth, AI Overview, schedule and budget; answers with the workspace as it now reads. */
export async function PUT(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await saveRankSettings(db, userId, siteId, await readJson(req, 16 * 1024));
    return Response.json(await readRankWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}
