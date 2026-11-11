import { auth } from "@/lib/auth";
import { checkOrigin } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { readPlatformOverview } from "@/lib/geo/platform-overview";
import { probeSite } from "@/lib/geo/probe";

export const runtime = "nodejs";
// About 30 requests to the site, a few at a time, stopped after 90 seconds.
export const maxDuration = 120;

/** Runs the live access check against the site and answers with the updated platform overview. */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await probeSite(db, userId, siteId, req.signal);
    return Response.json(await readPlatformOverview(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
