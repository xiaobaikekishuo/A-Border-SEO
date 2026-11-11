import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getImportablePages } from "@/lib/content-planner/pages";
import { contentErrorResponse } from "@/lib/content-planner/http";

export const runtime = "nodejs";
export async function GET(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const session = await auth();
    const { siteId } = await params;
    const query = Object.fromEntries(new URL(req.url).searchParams);
    return Response.json(await getImportablePages(db, session?.user?.id ?? "", siteId, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return contentErrorResponse(error); }
}
