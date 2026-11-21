import { auth } from "@/lib/auth";
import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { addTrackedKeywords, readRankWorkspace, setTracked } from "@/lib/rank-tracking/tracking";

export const runtime = "nodejs";
const RANK_FAILED = "The rank tracking request failed";

/** Saves keywords and tracks them ({keywords: [text]}); saved ones are tracked too. */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const result = await addTrackedKeywords(db, userId, siteId, await readJson(req, 64 * 1024));
    return Response.json({ ...result, workspace: await readRankWorkspace(db, userId, siteId) }, { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}

/** Turns tracking on or off for saved keywords ({ids: [savedKeywordId], tracked}). */
export async function PATCH(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const result = await setTracked(db, userId, siteId, await readJson(req, 64 * 1024));
    return Response.json({ ...result, workspace: await readRankWorkspace(db, userId, siteId) }, { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}
