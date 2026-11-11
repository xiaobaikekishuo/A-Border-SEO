import { finishConnection } from "@/lib/chatgpt-connection/service";
import { LOCAL_ORIGINS, localRequest } from "@/lib/chatgpt-connection/protocol";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" };
  try {
    localRequest(req);
    // Callback ownership is the one-use server-side transaction. Cookies from
    // localhost intentionally are not needed at the 127.0.0.1 callback.
    const result = await finishConnection(new URL(req.url));
    const destination = new URL(result.path, LOCAL_ORIGINS[0]);
    destination.searchParams.set("chatgpt", result.error ? "error" : "connected");
    if (result.error) destination.searchParams.set("chatgptError", result.error);
    return new Response(null, { status: 303, headers: { ...headers, Location: destination.toString() } });
  } catch { return new Response("ChatGPT connection could not be completed. Return to A-Border SEO and try again.", { status: 400, headers }); }
}
