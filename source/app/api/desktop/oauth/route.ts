import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ContentError, contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { db } from "@/lib/db";
import {
  beginAttempt,
  boundAttempt,
  DESKTOP_GA_CALLBACK,
  exchangeDesktopSession,
  OAUTH_HEADERS,
  oauthInput,
  requireDesktopOrigin,
  SESSION_COOKIE,
} from "@/lib/desktop/oauth";
import { decrypt } from "@/lib/encryption";
import { fetchGaSnapshot, gaRequest } from "@/lib/geo/ga-report";
import { ownedGeoSite, saveGaSnapshot } from "@/lib/geo/store";
import { managedAllows } from "@/lib/managed/policy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const origin = requireDesktopOrigin(req.headers, true);
    const input = oauthInput.parse(await readJson(req, 4096));
    if (input.action === "login") {
      return NextResponse.json(await beginAttempt(input, origin), { headers: OAUTH_HEADERS });
    }
    if (input.action === "ga4") {
      if (!managedAllows("geo")) throw new ContentError("managed_restricted", 403);
      const userId = (await auth())?.user?.id;
      if (!userId) throw new ContentError("GA_SESSION", 401);
      await ownedGeoSite(db, userId, input.siteId);
      return NextResponse.json(await beginAttempt(input, origin, userId), { headers: OAUTH_HEADERS });
    }

    const bound = boundAttempt(input.id, input.verifier);
    // Read the anonymous side first so approval between queries still finds the
    // newly created account-bound attempt.
    if (input.action === "status" && await db.desktopLoginChallenge.count({ where: bound })) {
      return NextResponse.json({ status: "pending" }, { headers: OAUTH_HEADERS });
    }
    if (input.action === "cancel" && (await db.desktopLoginChallenge.deleteMany({ where: bound })).count) {
      return NextResponse.json({ cancelled: true }, { headers: OAUTH_HEADERS });
    }
    const attempt = await db.desktopOAuthAttempt.findFirst({ where: bound });
    if (!attempt) throw new ContentError("DESKTOP_ATTEMPT_EXPIRED", 410);
    const userId = attempt.purpose === "ga4" ? (await auth())?.user?.id : null;
    if (attempt.purpose === "ga4" && (!userId || userId !== attempt.userId)) {
      throw new ContentError("GA_SESSION", 401);
    }
    if (input.action === "status") {
      return NextResponse.json({ status: attempt.status }, { headers: OAUTH_HEADERS });
    }
    if (input.action === "cancel") {
      await db.desktopOAuthAttempt.deleteMany({ where: bound });
      return NextResponse.json({ cancelled: true }, { headers: OAUTH_HEADERS });
    }
    if (attempt.status !== "approved") {
      throw new ContentError("DESKTOP_ATTEMPT_EXPIRED", 410);
    }

    if (attempt.purpose === "login") {
      const { sessionToken, expires } = await exchangeDesktopSession(input.id, input.verifier, attempt.userId);
      const response = NextResponse.json({ signedIn: true }, { headers: OAUTH_HEADERS });
      response.cookies.set(SESSION_COOKIE, sessionToken, { expires, path: "/", httpOnly: true, sameSite: "lax" });
      return response;
    }

    if (!managedAllows("geo")) throw new ContentError("managed_restricted", 403);
    if (!attempt.siteId || !attempt.code || !attempt.report) throw new ContentError("GA_AUTH", 403);
    const site = await ownedGeoSite(db, attempt.userId, attempt.siteId);
    const claimed = await db.desktopOAuthAttempt.deleteMany({ where: { ...bound, status: "approved" } });
    if (claimed.count !== 1) throw new ContentError("DESKTOP_ATTEMPT_EXPIRED", 410);
    const report = gaRequest.parse({ ...(attempt.report as object), code: decrypt(attempt.code) });
    const snapshot = await fetchGaSnapshot(report, site.domain, origin + DESKTOP_GA_CALLBACK, input.verifier);
    await saveGaSnapshot(db, attempt.userId, site.id, { ...snapshot, expectedUpdatedAt: report.expectedUpdatedAt });
    return NextResponse.json({ saved: true }, { headers: OAUTH_HEADERS });
  } catch (error) {
    const response = contentErrorResponse(error);
    for (const [name, value] of Object.entries(OAUTH_HEADERS)) response.headers.set(name, value);
    return response;
  }
}
