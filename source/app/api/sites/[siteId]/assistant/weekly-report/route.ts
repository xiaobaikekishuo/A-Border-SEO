import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { getWeeklyReport, saveWeeklyReport } from "@/lib/ai-workbench/weekly-settings";

export const runtime = "nodejs";
type Context = { params: Promise<{ siteId: string }> };
const headers = { "Cache-Control": "no-store" };
function errorResponse(error: unknown) {
  const response = contentErrorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The weekly AI action list switch of a site (lib/ai-workbench/weekly-settings.ts). */
export async function GET(_req: Request, { params }: Context) {
  try {
    return Response.json(await getWeeklyReport(db, (await auth())?.user?.id, (await params).siteId), { headers });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    return Response.json(await saveWeeklyReport(db, (await auth())?.user?.id, (await params).siteId, await readJson(req)), { headers });
  } catch (error) { return errorResponse(error); }
}
