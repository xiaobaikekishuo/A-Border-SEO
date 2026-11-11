import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { readPlatformOverview } from "@/lib/geo/platform-overview";

export const runtime = "nodejs";

/** Every AI platform on six layers: access, eligibility, index, report, answers, traffic. */
export async function GET(_req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    return Response.json(await readPlatformOverview(db, userId, (await params).siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
