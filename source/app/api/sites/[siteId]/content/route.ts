import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getContentWorkspace, ownedSite, runContentAction } from "@/lib/content-planner/data";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
export async function GET(_req: Request, { params }: Context) {
  try {
    const session = await auth();
    const { siteId } = await params;
    await ownedSite(db, session?.user?.id, siteId);
    return Response.json(await getContentWorkspace(db, session!.user!.id!, siteId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contentErrorResponse(error); }
}
export async function POST(req: Request, { params }: Context) {
  try {
    const session = await auth();
    const { siteId } = await params;
    await ownedSite(db, session?.user?.id, siteId);
    checkOrigin(req);
    const result = await runContentAction(db, session!.user!.id!, siteId, await readJson(req));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contentErrorResponse(error); }
}
