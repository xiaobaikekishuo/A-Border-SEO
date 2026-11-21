import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { getPoolView, runPoolAction, savePool } from "@/lib/ai-workbench/pool/view";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
const headers = { "Cache-Control": "no-store" };
function errorResponse(error: unknown) {
  const response = contentErrorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The background pool of a site (lib/ai-workbench/pool/view.ts); ?preview=1 adds what each filler would find now. */
export async function GET(req: Request, { params }: Context) {
  try {
    const preview = new URL(req.url).searchParams.get("preview") === "1";
    return Response.json(await getPoolView(db, (await auth())?.user?.id, (await params).siteId, new Date(), { preview }), { headers });
  } catch (error) { return errorResponse(error); }
}

/** The owner's pool settings and this site's fillers. */
export async function PUT(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    return Response.json(await savePool(db, (await auth())?.user?.id, (await params).siteId, await readJson(req)), { headers });
  } catch (error) { return errorResponse(error); }
}

/** Batch work, canceling a waiting item, marking results as reviewed. */
export async function POST(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    return Response.json(await runPoolAction(db, (await auth())?.user?.id, (await params).siteId, await readJson(req)), { headers });
  } catch (error) { return errorResponse(error); }
}
