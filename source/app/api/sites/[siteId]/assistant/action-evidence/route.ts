import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getActionEvidence } from "@/lib/ai-workbench/action-evidence";
import { parseActionScope } from "@/lib/ai-workbench/action-scope";
import { ContentError, contentErrorResponse } from "@/lib/content-planner/http";

export const runtime = "nodejs";
export async function GET(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const userId = (await auth())?.user?.id;
    if (!userId) throw new ContentError("Unauthorized", 401);
    const scope = parseActionScope(new URL(req.url).searchParams.get("scope"));
    if (!scope) throw new ContentError("Unknown report scope", 400);
    return Response.json(await getActionEvidence(db, userId, (await params).siteId, scope), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = contentErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
