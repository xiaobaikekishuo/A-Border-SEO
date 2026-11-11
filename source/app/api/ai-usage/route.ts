import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAiUsage } from "@/lib/ai-usage/data";
import { contentErrorResponse } from "@/lib/content-planner/http";

export const runtime = "nodejs";
const querySchema = z.object({ days: z.enum(["7", "30", "90"]).default("30"), siteId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional() }).strict();
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function GET(req: Request) {
  try {
    const session = await auth();
    const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return Response.json(await getAiUsage(db, session?.user?.id, Number(query.days), query.siteId ?? null), { headers });
  } catch (error) {
    const response = contentErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }
}
