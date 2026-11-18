import { NextResponse, type NextRequest } from "next/server";
import { desktopMaintenanceActive } from "@/lib/desktop/maintenance";
import { managedDecision, type ManagedFeature } from "@/lib/managed/policy";
import { hostedMode, HOSTED_COOKIE, sendHostedReceipt } from "@/lib/hosted/control";
import { boundHostedSession } from "@/lib/hosted/access";
import { db } from "@/lib/db";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/$/, "");
  const isRead = request.method === "GET" || request.method === "HEAD";
  const isApi = path.startsWith("/api/") || path === "/mcp";
  if (hostedMode()) {
    // These paths either contain no user data or enforce their own bearer/proof authentication.
    if (["/api/hosted/session", "/api/health", "/health", "/login", "/managed-status", "/api/local-content-worker", "/api/local-content-worker/chatgpt"].includes(path)
      || path.startsWith("/api/auth/") || path.startsWith("/api/v1/") || path === "/mcp"
      || path === "/desktop/oauth/ga4/callback" || path === "/desktop/oauth/google/callback") return NextResponse.next();
    const token = request.cookies.get(HOSTED_COOKIE)?.value;
    let session;
    try { session = token ? await boundHostedSession(db, token) : null; }
    catch {
      if (!isApi && isRead) return NextResponse.redirect(new URL("/managed-status", request.url));
      return NextResponse.json({ error: "hosted_verification_unavailable" }, { status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
    }
    if (!session) return isApi ? NextResponse.json({ error: "hosted_session_required" }, { status: 401, headers: { "Cache-Control": "no-store" } })
      : NextResponse.redirect(new URL("/login", request.url));
    const activeRead = ["/api/cron/tick", "/api/gsc/properties", "/api/bing/sites"].includes(path)
      || (path === "/api/chatgpt-connection" && request.nextUrl.searchParams.get("models") === "1")
      || /^\/api\/sites\/[^/]+\/manus-keywords\/[^/]+\/report$/.test(path);
    const feature = featureFor(path);
    const reason = !session.snapshot.allowed ? (session.snapshot.reason === "maintenance" && isRead && !activeRead ? null : session.snapshot.reason ?? "policy_denied")
      : feature && !session.snapshot.features[feature] && (!isRead || activeRead) ? "feature_disabled" : null;
    if (reason) {
      await sendHostedReceipt(session.snapshot, isApi ? "http_api" : "http_session", "blocked", reason);
      if (!isApi && isRead) return NextResponse.redirect(new URL("/managed-status", request.url));
      return NextResponse.json({ error: reason }, { status: reason === "maintenance" ? 503 : 403, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.next();
  }

  // The worker routes authenticate the token and gate new claims and executions
  // separately from finishing and heartbeating an existing lease.
  if (path === "/api/local-content-worker" || path === "/api/local-content-worker/chatgpt") {
    return NextResponse.next();
  }
  if (desktopMaintenanceActive() && path.startsWith("/api/") && (!isRead || path === "/api/cron/tick")) {
    return NextResponse.json({ error: "Workspace update in progress. Try again after it finishes." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }

  const decision = managedDecision();
  if (!decision.enabled || path === "/managed-status" || path === "/health" || path === "/api/health"
    || path === "/login" || path.startsWith("/api/auth/")
    || path === "/api/desktop/oauth" || path === "/desktop/oauth/login" || path === "/api/desktop/managed-login"
    || (isRead && /^\/api\/sites\/[^/]+\/export$/.test(path))) {
    return NextResponse.next();
  }

  // Existing read views stay available during maintenance. Exclude operations
  // which use GET for a state-changing scheduler or an external report fetch.
  const activeRead = ["/api/cron/tick", "/api/gsc/properties", "/api/bing/sites"].includes(path)
    || (path === "/api/chatgpt-connection" && request.nextUrl.searchParams.get("models") === "1")
    || /^\/api\/sites\/[^/]+\/manus-keywords\/[^/]+\/report$/.test(path);
  const feature = featureFor(path);
  const reason = !decision.allowed
    ? (decision.reason === "maintenance" && (isRead || path === "/mcp") && !activeRead ? null : decision.reason)
    : feature && !decision.features[feature] && (!isRead || activeRead) ? "feature_disabled" : null;
  if (!reason) return NextResponse.next();
  if (!isApi && isRead) return NextResponse.redirect(new URL("/managed-status", request.url));
  return NextResponse.json({ error: reason }, {
    status: reason === "maintenance" ? 503 : 403,
    headers: { "Cache-Control": "no-store" },
  });
}

function featureFor(path: string): ManagedFeature | undefined {
  if (path === "/api/desktop/oauth") return "geo";
  if (path === "/api/google/connection") return "jobs";
  if (/^\/api\/sites\/[^/]+\/(?:geo|geo-observations)(?:\/|$)/.test(path)) return "geo";
  if (/^\/api\/sites\/[^/]+\/manus-keywords(?:\/|$)/.test(path)) return "manus";
  if (path === "/api/chatgpt-connection"
    || /^\/api\/sites\/[^/]+\/(?:assistant|content|keyword-research)(?:\/|$)/.test(path)) return "codex";
  if (["/api/cron/tick", "/api/gsc/sync", "/api/bing/sync", "/api/gsc/properties", "/api/bing/sites"].includes(path)
    || /^\/api\/sites\/[^/]+\/(?:crawl|vitals|index-status|ai-access)(?:\/|$)/.test(path)) return "jobs";
  return undefined;
}

export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico|brand/|illustrations/|fonts/).*)" };
