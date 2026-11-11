import { auth } from "@/lib/auth";
import { checkOrigin, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { getConnectionStatus, runConnectionAction } from "@/lib/chatgpt-connection/service";
import { localRequest } from "@/lib/chatgpt-connection/protocol";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
function fail(error: unknown) { const response = contentErrorResponse(error); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response; }
export async function GET(req: Request) {
  try {
    localRequest(req);
    const session = await auth();
    return Response.json(await getConnectionStatus(session?.user?.id, new URL(req.url).searchParams.get("models") === "1"), { headers });
  } catch (error) { return fail(error); }
}
export async function POST(req: Request) {
  try {
    localRequest(req, true); checkOrigin(req);
    const session = await auth();
    return Response.json(await runConnectionAction(session?.user?.id, await readJson(req, 4096)), { headers });
  } catch (error) { return fail(error); }
}
