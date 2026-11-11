import { checkOrigin } from "@/lib/content-planner/http";
import { taskOwner, refreshTask, taskResponse, taskFailure } from "@/lib/manus/tasks";

export async function POST(req: Request, context: { params: Promise<{ siteId: string; taskId: string }> }) {
  try {
    checkOrigin(req);
    const { siteId, taskId } = await context.params;
    const owner = await taskOwner(siteId);
    return taskResponse({ task: await refreshTask(owner, taskId) });
  } catch (error) { return taskFailure(error); }
}
