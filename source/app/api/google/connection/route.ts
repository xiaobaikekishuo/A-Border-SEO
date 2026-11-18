import { auth } from "@/lib/auth";
import { contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { OAUTH_HEADERS, requireDesktopOrigin } from "@/lib/desktop/oauth";
import { googleConnectionInput, googleConnectionStatus, handleGoogleConnection } from "@/lib/google/connection";

export const runtime = "nodejs";
function failure(error: unknown) {
  const response = contentErrorResponse(error);
  for (const [name, value] of Object.entries(OAUTH_HEADERS)) response.headers.set(name, value);
  return response;
}
export async function GET() {
  try {
    const userId = (await auth())?.user?.id;
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401, headers: OAUTH_HEADERS });
    return Response.json(await googleConnectionStatus(userId), { headers: OAUTH_HEADERS });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  try {
    const origin = requireDesktopOrigin(req.headers, true);
    const userId = (await auth())?.user?.id;
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401, headers: OAUTH_HEADERS });
    const input = googleConnectionInput.parse(await readJson(req, 4096));
    return Response.json(await handleGoogleConnection(input, userId, origin), { headers: OAUTH_HEADERS });
  } catch (error) { return failure(error); }
}
