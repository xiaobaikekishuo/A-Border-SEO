import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { taskOwner, submitTask, taskList, taskResponse, taskFailure } from "@/lib/manus/tasks";

type Context = { params: Promise<{ siteId: string }> };

export async function GET(req: Request, context: Context) {
  try {
    const owner = await taskOwner((await context.params).siteId);
    return taskResponse(await taskList(owner, new URL(req.url).searchParams.get("cursor")));
  } catch (error) { return taskFailure(error); }
}

export async function POST(req: Request, context: Context) {
  try {
    checkOrigin(req);
    const owner = await taskOwner((await context.params).siteId);
    return taskResponse({ task: await submitTask(owner, await readJson(req, 16 * 1024)) });
  } catch (error) { return taskFailure(error); }
}
