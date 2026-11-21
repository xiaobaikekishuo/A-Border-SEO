import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { researchList, submitResearch, templateOf } from "@/lib/manus/research";
import { taskFailure, taskOwner, taskResponse } from "@/lib/manus/tasks";

type Context = { params: Promise<{ siteId: string }> };

/** The saved tasks of one template (?kind=GEO_SOURCES or LINK_PROSPECTS, &cursor=), with the options its form starts from. */
export async function GET(req: Request, context: Context) {
  try {
    const owner = await taskOwner((await context.params).siteId);
    const params = new URL(req.url).searchParams;
    return taskResponse(await researchList(owner, templateOf(params.get("kind")), params.get("cursor")));
  } catch (error) { return taskFailure(error); }
}

/** Starts one paid Manus task: {kind, confirmed: true, requestId, language, profile, ...the template's fields}. */
export async function POST(req: Request, context: Context) {
  try {
    checkOrigin(req);
    const owner = await taskOwner((await context.params).siteId);
    const body = await readJson(req, 16 * 1024) as Record<string, unknown> | null;
    return taskResponse({ task: await submitResearch(owner, templateOf(body?.kind), body) });
  } catch (error) { return taskFailure(error); }
}
