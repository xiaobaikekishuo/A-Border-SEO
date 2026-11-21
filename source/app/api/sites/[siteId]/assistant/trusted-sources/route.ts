import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, ContentError, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { addTrustedSources, checkTrustedSource, listTrustedSources, removeTrustedSource } from "@/lib/ai-workbench/trusted-sources";
import { managedAllows } from "@/lib/managed/policy";
import { currentHostedFeatureAllowed, hostedMode } from "@/lib/hosted/access";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";

/*
 * Trusted sources of a site (lib/ai-workbench/trusted-sources.ts).
 *   GET                                 the list
 *   POST {action:"add", sources:[{url, title?, note?}]}
 *   POST {action:"remove", id}
 *   POST {action:"check", id}           fetch the page once and record its status
 */

type Context = { params: Promise<{ siteId: string }> };
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function failure(error: unknown): Response {
  const known = error instanceof ContentError || error instanceof ZodError;
  if (!known) console.error(error);
  const response = known ? contentErrorResponse(error) : Response.json({ error: "The trusted source request failed" }, { status: 500 });
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/** Checking a page leaves the server, so it follows the policy of other outside requests (IndexNow, Bing). */
async function restricted(): Promise<boolean> {
  return desktopMaintenanceActive() || !(hostedMode() ? await currentHostedFeatureAllowed("jobs", true) : managedAllows("jobs"));
}

export async function GET(_req: Request, { params }: Context) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    return Response.json({ sources: await listTrustedSources(db, userId, siteId) }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const body = await readJson(req, 256 * 1024) as { action?: unknown; id?: unknown } & Record<string, unknown>;
    const { action, id, ...rest } = body ?? {};
    if (action === "add") return Response.json(await addTrustedSources(db, userId, siteId, rest), { headers: NO_STORE });
    if (typeof id !== "string" || !id || id.length > 100) throw new ContentError("Choose a source", 400);
    if (action === "remove") return Response.json({ sources: await removeTrustedSource(db, userId, siteId, id) }, { headers: NO_STORE });
    if (action !== "check") throw new ContentError("Unknown action", 400);
    if (await restricted()) throw new ContentError("Checking pages is unavailable under the current policy or during an update", 403);
    return Response.json(await checkTrustedSource(db, userId, siteId, id), { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}
