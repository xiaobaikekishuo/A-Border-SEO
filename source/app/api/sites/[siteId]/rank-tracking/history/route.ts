import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { keywordHistory } from "@/lib/rank-tracking/tracking";

export const runtime = "nodejs";
const RANK_FAILED = "The rank tracking request failed";

/** One keyword's measured positions (?keyword=), oldest first, with the first ten results of the newest check. */
export async function GET(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const keyword = new URL(req.url).searchParams.get("keyword") ?? "";
    return Response.json(await keywordHistory(db, userId, siteId, keyword), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error, RANK_FAILED);
  }
}
