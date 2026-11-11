import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, ContentError, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { RateLimiter } from "@/lib/rate-limit";
import { fetchGaSnapshot, gaRequest } from "@/lib/geo/ga-report";
import { ownedGeoSite, saveGaSnapshot } from "@/lib/geo/store";

export const runtime = "nodejs";
type Ctx = { params: Promise<{siteId:string}> };
const headers = { "Cache-Control":"no-store" };
const limiter = new RateLimiter(5);

function errorResponse(error: unknown) {
  const response = contentErrorResponse(error);
  response.headers.set("Cache-Control","no-store");
  return response;
}

export async function GET(_req: Request, {params}: Ctx) {
  try {
    const userId = (await auth())?.user?.id;
    const {siteId} = await params;
    await ownedGeoSite(db,userId,siteId);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) throw new ContentError("GA_CONFIG",503);
    return Response.json({clientId}, {headers});
  } catch(error) { return errorResponse(error); }
}

export async function POST(req: Request,{params}: Ctx) {
  try {
    const userId = (await auth())?.user?.id;
    if (!userId) throw new ContentError("Unauthorized",401);
    checkOrigin(req);
    const origin = req.headers.get("origin");
    if (!origin || req.headers.get("X-Requested-With") !== "XmlHttpRequest") throw new ContentError("GA_ORIGIN",403);
    const {siteId} = await params;
    const site = await ownedGeoSite(db,userId,siteId);
    const parsed = gaRequest.safeParse(await readJson(req,8192));
    if (!parsed.success) throw new ContentError("GA_INPUT",422);
    if (!limiter.hit(userId).ok) throw new ContentError("GA_QUOTA",429);
    const data = await fetchGaSnapshot(parsed.data,site.domain,origin);
    await saveGaSnapshot(db,userId,siteId,{...data,expectedUpdatedAt:parsed.data.expectedUpdatedAt});
    return Response.json({saved:true}, {headers});
  } catch(error) { return errorResponse(error); }
}
