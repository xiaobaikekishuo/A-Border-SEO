import { completeDesktopGa4, DESKTOP_GA_CALLBACK, OAUTH_HEADERS, oauthValue, requireDesktopOrigin } from "@/lib/desktop/oauth";

export const runtime = "nodejs";

const headers = {
  ...OAUTH_HEADERS,
  "Content-Type": "text/plain; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(req: Request) {
  try {
    const origin = requireDesktopOrigin(req.headers);
    const params = new URL(req.url).searchParams;
    if (params.get("finished") === "1") {
      return new Response("Return to A-Border SEO to see the report status.\n请返回 A-Border SEO 查看报表状态。", { headers });
    }
    if (["state", "code", "error"].some(name => params.getAll(name).length > 1)) throw new Error();
    const id = oauthValue.parse(params.get("state"));
    const code = params.get("code");
    const grant = !params.has("error") && code && code.length <= 4096 ? code : null;
    if (await completeDesktopGa4(id, grant)) {
      return new Response(null, { status: 303, headers: { ...headers, Location: origin + DESKTOP_GA_CALLBACK + "?finished=1" } });
    }
  } catch {
    // Provider response fields can contain credentials. Return a fixed message.
  }
  return new Response("The request has expired or is invalid. Return to A-Border SEO and try again.\n请求已失效或无效，请返回 A-Border SEO 重试。", { status: 400, headers });
}
