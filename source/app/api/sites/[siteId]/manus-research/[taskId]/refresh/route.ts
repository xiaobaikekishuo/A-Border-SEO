import { checkOrigin } from "@/lib/content-planner/http";
import { refreshResearch } from "@/lib/manus/research";
import { taskFailure, taskOwner, taskResponse } from "@/lib/manus/tasks";

/** Reads a template task's status and, once it finished, its structured result from Manus. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string; taskId: string }> }) {
  try {
    checkOrigin(req);
    const { siteId, taskId } = await context.params;
    const owner = await taskOwner(siteId);
    return taskResponse({ task: await refreshResearch(owner, taskId) });
  } catch (error) { return taskFailure(error); }
}
