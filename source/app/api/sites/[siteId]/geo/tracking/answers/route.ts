import { auth } from "@/lib/auth";
import { checkOrigin, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import { geoFailure, NO_STORE, type SiteContext } from "@/lib/geo/http";
import { deleteManualAnswer, readAnswer, readTrackingWorkspace, recordManualAnswer } from "@/lib/geo/tracking";

export const runtime = "nodejs";

/** One answer in full (?id=), read with the current brand settings, and its earlier answers. */
export async function GET(req: Request, { params }: SiteContext) {
  try {
    const userId = (await auth())?.user?.id;
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return Response.json(await readAnswer(db, userId, (await params).siteId, id), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}

/** Records an answer seen in the platform's own app ({promptId, platform, status, text, citations}). */
export async function POST(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    const { id } = await recordManualAnswer(db, userId, siteId, await readJson(req, 256 * 1024));
    return Response.json({ id, workspace: await readTrackingWorkspace(db, userId, siteId) }, { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}

/** Deletes a recorded answer (?id=). Answers fetched by a run stay with the run. */
export async function DELETE(req: Request, { params }: SiteContext) {
  try {
    checkOrigin(req);
    const userId = (await auth())?.user?.id;
    const { siteId } = await params;
    await deleteManualAnswer(db, userId, siteId, new URL(req.url).searchParams.get("id") ?? "");
    return Response.json(await readTrackingWorkspace(db, userId, siteId), { headers: NO_STORE });
  } catch (error) {
    return geoFailure(error);
  }
}
