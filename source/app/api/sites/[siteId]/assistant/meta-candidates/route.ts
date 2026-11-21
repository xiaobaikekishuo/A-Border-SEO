import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ownedSite } from "@/lib/content-planner/data";
import { contentErrorResponse } from "@/lib/content-planner/http";
import { metaRewriteCandidates } from "@/lib/ai-workbench/tools/meta-rewrite";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

/** Pages to rewrite titles and descriptions for: many impressions, few clicks for their position (lib/ai-workbench/tools/meta-rewrite.ts). */
export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const site = await ownedSite(db, (await auth())?.user?.id, (await params).siteId);
    return Response.json(await db.$transaction(tx => metaRewriteCandidates(tx, site), { isolationLevel: "RepeatableRead" }), { headers });
  } catch (error) {
    const response = contentErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
