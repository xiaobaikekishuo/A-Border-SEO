import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getWorkbenchWorkspace, runWorkbenchAction } from "@/lib/ai-workbench/data";
import { checkOrigin, contentErrorResponse, readJson, ContentError } from "@/lib/content-planner/http";
import { isPanelKind } from "@/lib/ai-workbench/tools";
import { jobParam } from "@/lib/ai-workbench/job-link";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
const headers = { "Cache-Control": "no-store" };
function errorResponse(error: unknown) { const response = contentErrorResponse(error); response.headers.set("Cache-Control", "no-store"); return response; }
export async function GET(req: Request, { params }: Context) {
  try {
    const session = await auth();
    const search = new URL(req.url).searchParams;
    const kind = search.get("kind");
    if (kind !== null && !isPanelKind(kind)) throw new ContentError("Unknown assistant task filter");
    const siteId = (await params).siteId;
    // ?job=: a task a link points at, listed even when older than the latest 20.
    const workspace = await getWorkbenchWorkspace(db, session?.user?.id, siteId, new Date(), kind ?? undefined, jobParam(search.get("job")));
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
