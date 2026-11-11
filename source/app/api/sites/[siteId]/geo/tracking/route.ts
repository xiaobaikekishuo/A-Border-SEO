import { auth } from "@/lib/auth";
import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { readTrackingProgress, readTrackingWorkspace, saveTrackingSettings } from "@/lib/geo/tracking";

export const runtime = "nodejs";

/**
 * Prompt tracking: settings, prompts, recent runs and the latest answer per
 * prompt and platform. ?view=progress answers only the active job and the
 * latest run, for polling while a run is going.
 */
export async function GET(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    if (new URL(req.url).searchParams.get("view") === "progress") {
      return Response.json(await readTrackingProgress(db, userId, siteId), { headers: NO_STORE });
    }
    return Response.json(await readTrackingWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}

/** Saves brands, platforms, schedule and budget; answers with the workspace as it now reads. */
export async function PUT(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await saveTrackingSettings(db, userId, siteId, await readJson(req, 64 * 1024));
    return Response.json(await readTrackingWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
