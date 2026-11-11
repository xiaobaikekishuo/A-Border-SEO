import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { readGeoWorkspace, saveGeoImport, ownedGeoSite } from "@/lib/geo/store";
export const runtime = "nodejs";
type Context = {params: Promise<{siteId:string}>};
const headers = {"Cache-Control":"private, no-store"};
function failure(error:unknown) {
  const response = contentErrorResponse(error);
  response.headers.set("Cache-Control",headers["Cache-Control"]);
  return response;
}
export async function GET(_req:Request, {params}:Context) {
  try {
    const userId = (await auth())?.user?.id;
    return Response.json(await readGeoWorkspace(db,userId,(await params).siteId),{headers});
  } catch(error) { return failure(error); }
}
export async function POST(req:Request, {params}:Context) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const {siteId} = await params;
    await ownedGeoSite(db,userId,siteId);
    return Response.json(await saveGeoImport(db,userId,siteId,await readJson(req,2*1024*1024)),{headers});
  } catch(error) { return failure(error); }
}
