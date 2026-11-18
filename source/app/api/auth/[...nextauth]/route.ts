import { handlers } from "@/lib/auth";
import type { NextRequest } from "next/server";
import { GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_STATE_PREFIX } from "@/lib/google/connection-protocol";
import { handleGoogleConnectionCallback } from "@/lib/google/connection-callback";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Recognize the namespace even for malformed or duplicated states, so a
  // rejected data-connection request never becomes an application sign-in.
  if (url.pathname === GOOGLE_CONNECTION_CALLBACK
    && url.searchParams.getAll("state").some(state => state.startsWith(GOOGLE_CONNECTION_STATE_PREFIX))) {
    return handleGoogleConnectionCallback(req);
  }
  return handlers.GET(req);
}

export const POST = handlers.POST;
