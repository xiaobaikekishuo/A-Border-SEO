import { checkOrigin } from "@/lib/content-planner/http";
import { getPreview, loadPreview, previewOwner, type PreviewParams } from "@/lib/manus/keyword-preview";
import { taskFailure, taskResponse } from "@/lib/manus/tasks";

export async function GET(_req: Request, ctx: { params: Promise<PreviewParams> }) {
  try { return taskResponse(await getPreview(await previewOwner(await ctx.params))); }
  catch (error) { return taskFailure(error); }
}

export async function POST(req: Request, ctx: { params: Promise<PreviewParams> }) {
  try {
    checkOrigin(req);
    return taskResponse(await loadPreview(await previewOwner(await ctx.params), req));
  } catch (error) { return taskFailure(error); }
}
