import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentErrorResponse, readJson } from "@/lib/content-planner/http";
import { HOSTED_COOKIE, hostedMode, sendHostedReceipt } from "@/lib/hosted/control";
import { currentHostedPolicy } from "@/lib/hosted/access";
import { createHostedSession, revokeHostedSessions } from "@/lib/hosted/session";

export const runtime = "nodejs";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  if (!hostedMode()) return Response.json({ error: "hosted_disabled" }, { status: 404, headers });
  try {
    const policy = await currentHostedPolicy();
    if (!policy) return Response.json({ error: "hosted_session_required" }, { status: 401, headers });
    if (!policy.allowed && policy.reason !== "maintenance") {
      await sendHostedReceipt(policy, "http_session", "blocked", policy.reason ?? "policy_denied");
      return Response.json({ error: policy.reason ?? "policy_denied" }, { status: 403, headers });
    }
    return Response.json({ maintenance: policy.reason === "maintenance", message: policy.maintenanceMessage }, { headers });
  } catch { return Response.json({ error: "hosted_verification_unavailable" }, { status: 503, headers }); }
}

export async function POST(req: Request) {
  try {
    const session = await createHostedSession(db, req.headers, await readJson(req, 4096));
    const response = NextResponse.json({ ok: true, hostedMode: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(HOSTED_COOKIE, session.sessionToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: session.expires });
    return response;
  } catch (error) { return contentErrorResponse(error); }
}

export async function DELETE(req: Request) {
  try {
    return NextResponse.json(await revokeHostedSessions(db, req.headers, await readJson(req, 4096)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return contentErrorResponse(error); }
}
