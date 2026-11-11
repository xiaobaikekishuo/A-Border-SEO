import { auth } from "@/lib/auth";
import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { addPrompts, deletePrompt, readTrackingWorkspace, updatePrompt } from "@/lib/geo/tracking";

export const runtime = "nodejs";

/** Adds prompts ({prompts: [{text, tag}]}); ones the site already tracks are skipped. */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const result = await addPrompts(db, userId, siteId, await readJson(req, 128 * 1024));
    return Response.json({ ...result, workspace: await readTrackingWorkspace(db, userId, siteId) }, { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}

/** Turns a prompt on or off, or changes its tag ({id, active?, tag?}). */
export async function PATCH(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await updatePrompt(db, userId, siteId, await readJson(req, 16 * 1024));
    return Response.json(await readTrackingWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}

/** Deletes a prompt (?id=) with every answer collected for it. */
export async function DELETE(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await deletePrompt(db, userId, siteId, new URL(req.url).searchParams.get("id") ?? "");
    return Response.json(await readTrackingWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
