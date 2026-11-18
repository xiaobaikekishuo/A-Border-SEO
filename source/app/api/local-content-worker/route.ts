import { db } from "@/lib/db";
import { authorizeWorker, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { hostedMode } from "@/lib/hosted/control";
import { withHostedWorker } from "@/lib/hosted/session";

export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!hostedMode() && !authorizeWorker(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const input = await readJson(req, 512 * 1024);
    const run = () => runWorkerAction(db, input);
    return Response.json(await (hostedMode() ? withHostedWorker(db, req, input, run) : run()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return contentErrorResponse(error); }
}
