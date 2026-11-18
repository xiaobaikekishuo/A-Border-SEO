import { authorizeWorker, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { runPlanInference } from "@/lib/ai-workbench/plan-inference";

export const runtime = "nodejs";
export const maxDuration = 540;
export async function POST(req: Request) {
  if (process.env.ABORDER_HOSTED === "1") return Response.json({ error: "hosted_inference_requires_local_codex" }, { status: 409 });
  if (!authorizeWorker(req.headers.get("authorization"))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json(await runPlanInference(await readJson(req, 2048), req.signal), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return contentErrorResponse(error); }
}
