import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";

export class ContentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function authorizeWorker(header: string | null, token = process.env.LOCAL_CONTENT_WORKER_TOKEN): boolean {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
export function checkOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const requestUrl = new URL(req.url);
  const host = req.headers.get("host") ?? requestUrl.host;
  const forwardedProtocol = req.headers.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http" ? `${forwardedProtocol}:` : requestUrl.protocol;
  let expected: string;
  try { expected = new URL(`${protocol}//${host}`).origin; }
  catch { throw new ContentError("Invalid request origin", 403); }
  if (origin !== expected) throw new ContentError("Cross-origin mutations are not allowed", 403);
}
export async function readJson(req: Request, maxBytes = 128 * 1024): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ContentError("Content-Type must be application/json", 415);
  }
  if (Number(req.headers.get("content-length")) > maxBytes) throw new ContentError("Request body too large", 413);
  if (!req.body) throw new ContentError("A JSON body is required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) { await reader.cancel(); throw new ContentError("Request body too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ContentError("Invalid JSON body"); }
}
export function contentErrorResponse(error: unknown): Response {
  if (error instanceof ContentError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    return Response.json({ error: error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") }, { status: 400 });
  }
  if (error && typeof error === "object" && "code" in error && ["P2002", "P2003", "P2025"].includes(String(error.code))) {
    return Response.json({ error: "This record conflicts with an existing or changed record. Reload and try again." }, { status: 409 });
  }
  return Response.json({ error: "Content planner operation failed" }, { status: 500 });
}
