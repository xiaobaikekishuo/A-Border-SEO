import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, ContentError, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { probeAiAccess } from "@/lib/seo/ai-access";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
export async function POST(req: Request, { params }: Context) {
  try {
    const session = await auth();
    if (!session?.user?.id) throw new ContentError("Unauthorized", 401);
    checkOrigin(req);
    const report = await probeAiAccess(db, session?.user?.id, (await params).siteId, await readJson(req, 4096));
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = contentErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
