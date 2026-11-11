import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getWorkbenchWorkspace, runWorkbenchAction } from "@/lib/ai-workbench/data";
import { checkOrigin, contentErrorResponse, readJson, ContentError } from "@/lib/content-planner/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
const headers = { "Cache-Control": "no-store" };
function errorResponse(error: unknown) { const response = contentErrorResponse(error); response.headers.set("Cache-Control", "no-store"); return response; }
export async function GET(req: Request, { params }: Context) {
  try {
    const session = await auth();
    const kind = new URL(req.url).searchParams.get("kind");
    if (kind !== null && kind !== "KEYWORD_RESEARCH" && kind !== "DOMAIN_ANALYSIS" && kind !== "BACKLINK_ANALYSIS") throw new ContentError("Unknown assistant task filter");
    const siteId = (await params).siteId;
    const workspace = kind ? await getWorkbenchWorkspace(db, session?.user?.id, siteId, new Date(), kind) : await getWorkbenchWorkspace(db, session?.user?.id, siteId);
    return Response.json(workspace, { headers });
  }
  catch (error) { return errorResponse(error); }
}
export async function POST(req: Request, { params }: Context) {
  try {
    const session = await auth(); checkOrigin(req);
    return Response.json(await runWorkbenchAction(db, session?.user?.id, (await params).siteId, await readJson(req, 512 * 1024)), { headers });
  } catch (error) { return errorResponse(error); }
}
