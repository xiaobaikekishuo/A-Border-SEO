import { db } from "@/lib/db";
import { authorizeWorker, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { runWorkerAction } from "@/lib/content-planner/worker";

export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!authorizeWorker(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await runWorkerAction(db, await readJson(req, 512 * 1024)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contentErrorResponse(error); }
}
