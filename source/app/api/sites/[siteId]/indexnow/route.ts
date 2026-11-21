import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkOrigin, ContentError, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { createIndexNowKey, readIndexNow, submitIndexNow, verifyIndexNowKey } from "@/lib/indexnow/service";
import { managedAllows } from "@/lib/managed/policy";
import { currentHostedFeatureAllowed, hostedMode } from "@/lib/hosted/access";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";

/*
 * IndexNow for one site (lib/indexnow/service.ts).
 *   GET                         the key, its check and the last submission
 *   POST {action:"key"}         a new key (replaces the old one)
 *   POST {action:"verify"}      fetch https://<domain>/<key>.txt and check it
 *   POST {action:"submit", source:"changed"|"list", urls?}
 */

type Context = { params: Promise<{ siteId: string }> };
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function failure(error: unknown): Response {
  const known = error instanceof ContentError || error instanceof ZodError;
  if (!known) console.error(error);
  const response = known ? contentErrorResponse(error) : Response.json({ error: "The IndexNow request failed" }, { status: 500 });
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}

/** Requests that leave the server follow the same policy as other outside syncs (Bing). */
async function restricted(): Promise<boolean> {
  return desktopMaintenanceActive() || !(hostedMode() ? await currentHostedFeatureAllowed("jobs", true) : managedAllows("jobs"));
}

export async function GET(_req: Request, { params }: Context) {
  try {
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    return Response.json(await readIndexNow(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const body = await readJson(req, 1024 * 1024) as { action?: unknown } & Record<string, unknown>;
    const { action, ...rest } = body ?? {};
    if (action === "key") return Response.json(await createIndexNowKey(db, userId, siteId), { headers: NO_STORE });
    if (action !== "verify" && action !== "submit") throw new ContentError("Unknown action", 400);
    if (await restricted()) throw new ContentError("IndexNow is unavailable under the current policy or during an update", 403);
    if (action === "verify") return Response.json(await verifyIndexNowKey(db, userId, siteId), { headers: NO_STORE });
    return Response.json(await submitIndexNow(db, userId, siteId, rest), { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}
