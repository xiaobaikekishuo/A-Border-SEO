import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { importQueryClusters } from "@/lib/ai-workbench/tools/query-clusters";

export const runtime = "nodejs";

/** Adds chosen query clusters of a finished task to a pillar of the content plan. */
export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    return Response.json(await importQueryClusters(db, userId, (await params).siteId, await readJson(req)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = contentErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
