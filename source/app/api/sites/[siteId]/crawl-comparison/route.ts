import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCrawlComparison } from "@/lib/seo/crawl-comparison";
import { contentErrorResponse } from "@/lib/content-planner/http";

export const runtime = "nodejs";
export async function GET(req: Request, context: { params: Promise<{ siteId: string }> }) {
  try {
    const session = await auth();
    const result = await getCrawlComparison(db, session?.user?.id, (await context.params).siteId, Object.fromEntries(new URL(req.url).searchParams));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = contentErrorResponse(error); response.headers.set("Cache-Control", "no-store"); return response;
  }
}
