import { ContentError } from "@/lib/content-planner/http";
import { downloadResearchReport } from "@/lib/manus/client";
import { previewOwner, type PreviewParams } from "@/lib/manus/keyword-preview";
import { taskFailure, taskResponse, userKey } from "@/lib/manus/tasks";

export async function GET(_req: Request, ctx: { params: Promise<PreviewParams> }) {
  try {
    const owner = await previewOwner(await ctx.params);
    if (!owner.remoteId) throw new ContentError("no_report", 404);
    const report = await downloadResearchReport(await userKey(owner.userId), owner.remoteId);
    return taskResponse(report);
  } catch (error) { return taskFailure(error); }
}
