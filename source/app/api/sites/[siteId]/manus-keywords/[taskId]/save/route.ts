import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { previewOwner, saveSelection, type PreviewParams } from "@/lib/manus/keyword-preview";
import { taskFailure, taskResponse } from "@/lib/manus/tasks";

export async function POST(req: Request, ctx: { params: Promise<PreviewParams> }) {
  try {
    checkOrigin(req);
    const owner = await previewOwner(await ctx.params);
    return taskResponse(await saveSelection(owner, await readJson(req, 1024 * 1024)));
  } catch (error) { return taskFailure(error); }
}
