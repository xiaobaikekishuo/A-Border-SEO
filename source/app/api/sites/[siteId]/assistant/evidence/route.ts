import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDiagnosticEvidence } from "@/lib/ai-workbench/diagnostic";
import { contentErrorResponse } from "@/lib/content-planner/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
export async function GET(req: Request, { params }: Context) {
  try {
    const session = await auth();
    const selection = Object.fromEntries(new URL(req.url).searchParams);
    return Response.json(await getDiagnosticEvidence(db, session?.user?.id, (await params).siteId, selection), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = contentErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
