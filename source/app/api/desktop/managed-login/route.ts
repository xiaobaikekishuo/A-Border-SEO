import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { createManagedSession, managedLoginInput } from "@/lib/desktop/managed-session";
import { OAUTH_HEADERS, requireDesktopOrigin, SESSION_COOKIE } from "@/lib/desktop/oauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    requireDesktopOrigin(req.headers, true);
    const input = managedLoginInput.parse(await readJson(req, 2048));
    const { sessionToken, expires } = await createManagedSession(db, input);
    const response = NextResponse.json({ signedIn: true }, { headers: OAUTH_HEADERS });
    response.cookies.set(SESSION_COOKIE, sessionToken, { expires, path: "/", httpOnly: true, sameSite: "lax" });
    return response;
  } catch (error) {
    const response = contentErrorResponse(error);
    for (const [name, value] of Object.entries(OAUTH_HEADERS)) response.headers.set(name, value);
    return response;
  }
}
