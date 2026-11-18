import { oauthValue, OAUTH_HEADERS, requireDesktopOrigin } from "@/lib/desktop/oauth";
import { completeGoogleConnection, GOOGLE_CONNECTION_CALLBACK, GOOGLE_CONNECTION_LEGACY_CALLBACK, GOOGLE_CONNECTION_STATE_PREFIX } from "./connection";

const headers = { ...OAUTH_HEADERS, "Content-Type": "text/plain; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" };

/** Stages only this app's one-use grant. It never delegates to Auth.js or signs in. */
export async function handleGoogleConnectionCallback(req: Request) {
  try {
    const origin = requireDesktopOrigin(req.headers);
    const url = new URL(req.url);
    const params = url.searchParams;
    const legacy = url.pathname === GOOGLE_CONNECTION_LEGACY_CALLBACK;
    if (!legacy && url.pathname !== GOOGLE_CONNECTION_CALLBACK) throw new Error();
    if (legacy && params.size === 1 && params.get("finished") === "1") {
      return new Response("Return to A-Border SEO to finish connecting Google.\n请返回 A-Border SEO 完成 Google 连接。", { headers });
    }
    if (["state", "code", "error"].some(name => params.getAll(name).length > 1)) throw new Error();
    const state = params.get("state") ?? "";
    if (!legacy && !state.startsWith(GOOGLE_CONNECTION_STATE_PREFIX)) throw new Error();
    const id = oauthValue.parse(state.startsWith(GOOGLE_CONNECTION_STATE_PREFIX) ? state.slice(GOOGLE_CONNECTION_STATE_PREFIX.length) : state);
    const code = params.get("code");
    const grant = !params.has("error") && code && code.length <= 4096 ? code : null;
    if (await completeGoogleConnection(id, grant, origin, origin + url.pathname)) {
      // Remove the authorization code from the browser URL before showing a result.
      return new Response(null, { status: 303, headers: { ...headers, Location: origin + GOOGLE_CONNECTION_LEGACY_CALLBACK + "?finished=1" } });
    }
  } catch { /* Never display provider codes, tokens or raw error details. */ }
  return new Response("This connection request is invalid or expired. Return to A-Border SEO and try again.\n连接请求无效或已过期，请返回 A-Border SEO 重试。", { status: 400, headers });
}
