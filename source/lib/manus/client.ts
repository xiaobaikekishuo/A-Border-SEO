import type { ProxyAgent } from "undici";
import { createLocalProxy } from "@/lib/http/local-proxy";
import { MAX_WORKBOOK_BYTES } from "./workbook-limits";
import { normalizeResearchInput, researchPrompt } from "./prompt";
import { ManusError, type ManusErrorCode, type ManusResearchInput, type ManusResearchResult } from "./types";

export { normalizeResearchInput, ManusError };
export type { ManusErrorCode, ManusResearchInput, ManusResearchResult };

type Endpoint = "user.me" | "task.create" | "task.detail" | "task.listMessages" | "artifact.list";
const api = "https://api.manus.ai/v2/";
const localProxy = createLocalProxy("MANUS_HTTP_PROXY");
const validId = /^[A-Za-z0-9_-]{1,256}$/;
const outputOrigins = new Set(["https://private.manuscdn.com", "https://private-us-east-1.manuscdn.com"]);
const taskPage = (id: string) => `https://manus.im/app/${id}`;
const responseLimit = 2 * 1024 * 1024;
const reportLimit = 256 * 1024;
type OutputKind = "workbook" | "report";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function containsKey(text: string, key: string): boolean {
  if (text.includes(key)) return true;
  try { return decodeURIComponent(text).includes(key); }
  catch { return false; }
}

function credentials(key: string): string {
  const trimmed = key.trim();
  if (!/^[!-~]{1,4096}$/.test(trimmed)) throw new ManusError("unauthorized");
  return trimmed;
}

function proxyOptions(): { dispatcher?: ProxyAgent } {
  const proxy = process.env.MANUS_HTTP_PROXY?.trim();
  if (!proxy) return {};
  try { return { dispatcher: localProxy(proxy) }; }
  catch { throw new ManusError("network"); }
}

async function readBytes(response: Response, limit: number, sizeError: ManusErrorCode): Promise<Buffer> {
  if (!response.body) throw new ManusError("invalid_response");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new ManusError(sizeError);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ManusError(sizeError);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBytes(response, responseLimit, "invalid_response");
  return record(JSON.parse(bytes.toString("utf8")));
}

function errorCode(status: number, code: unknown): ManusErrorCode {
  if (status === 401 || code === "unauthenticated") return "unauthorized";
  if (status === 403 || code === "permission_denied") return "forbidden";
  if (status === 402 || code === "insufficient_credits") return "insufficient_credits";
  if (status === 429 || code === "rate_limited") return "rate_limited";
  if (status === 404 || code === "not_found") return "not_found";
  if (status === 400 || code === "invalid_argument") return "invalid_input";
  return "upstream";
}

async function request(key: string, endpoint: Endpoint, query?: URLSearchParams, body?: object) {
  const url = new URL(endpoint, api);
  if (query) url.search = query.toString();
  const write = endpoint === "task.create";
  const options = proxyOptions();
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      method: write ? "POST" : "GET",
      headers: { "x-manus-api-key": key, ...(write ? { "Content-Type": "application/json" } : {}) },
      body: write ? JSON.stringify(body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new ManusError("network", write); }

  const data = await readEnvelope(response).catch(() => ({} as Record<string, unknown>));
  if (!response.ok || data.ok === false) {
    const code = errorCode(response.status, record(data.error).code);
    const knownRejection = code !== "upstream" || (response.status >= 400 && response.status < 500);
    throw new ManusError(code, write && (response.status === 408 || response.status >= 500 || !knownRejection));
  }
  if (data.ok !== true) throw new ManusError("invalid_response", write);
  return data;
}

export async function checkKey(key: string): Promise<void> {
  const data = await request(credentials(key), "user.me");
  if (typeof data.user_id !== "string" || !data.user_id.trim()) throw new ManusError("invalid_response");
}

export async function createResearch(key: string, input: ManusResearchInput) {
  const secret = credentials(key);
  const normalized = normalizeResearchInput(input);
  if (containsKey(JSON.stringify(normalized), secret)) throw new ManusError("invalid_input");
  const data = await request(secret, "task.create", undefined, {
    agent_profile: "lite",
    share_visibility: "private",
    interactive_mode: false,
    clear_connectors: true,
    title: `SEO keyword research · ${normalized.seeds[0]}`,
    message: { content: [{ type: "text", text: researchPrompt(normalized) }] },
  });
  const id = data.task_id;
  if (typeof id !== "string" || !validId.test(id) || containsKey(id, secret)) {
    throw new ManusError("invalid_response", true);
  }
  return { remoteId: id, taskUrl: taskPage(id) };
}

function taskStatus(task: Record<string, unknown>): ManusResearchResult["status"] {
  switch (task.status) {
    case "running": case "waiting": return task.status;
    case "stopped": return task.has_running_background_jobs === true ? "running" : "completed";
    case "error": case "deleted": return "failed";
    default: throw new ManusError("invalid_response");
  }
}

function outputFile(value: unknown, key: string, kind: OutputKind): ManusResearchResult["files"][number] | null {
  const { type, filename, url } = record(value);
  const extension = kind === "workbook" ? /\.xlsx$/i : /\.(md|markdown)$/i;
  if (type !== "file" || typeof filename !== "string" || filename.length > 255 || !extension.test(filename)) return null;
  if (filename.includes("/") || filename.includes("\\") || containsKey(filename, key) ||
      Array.from(filename).some(char => char < " " || char === "\u007f")) return null;
  if (typeof url !== "string" || url.length > 8192 || containsKey(url, key)) return null;
  try {
    const link = new URL(url);
    if (link.protocol !== "https:" || !outputOrigins.has(link.origin) || link.username || link.password) return null;
    return { name: filename, url: link.href };
  } catch { return null; }
}

function taskCredentials(key: string, remoteId: string) {
  const secret = credentials(key);
  if (!validId.test(remoteId) || containsKey(remoteId, secret)) throw new ManusError("invalid_input");
  return secret;
}

async function* outputPages(secret: string, remoteId: string, endpoint: "task.listMessages" | "artifact.list") {
  const query = new URLSearchParams({ task_id: remoteId, limit: "50" });
  if (endpoint === "task.listMessages") query.set("order", "desc");
  else query.set("type", "spreadsheets");
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const data = await request(secret, endpoint, query);
    yield data;
    if (!data.has_more) break;
    const cursor = data.next_cursor;
    if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || seen.has(cursor) || containsKey(cursor, secret)) {
      throw new ManusError("invalid_response");
    }
    seen.add(cursor);
    query.set("cursor", cursor);
  }
}

async function researchMessages(secret: string, remoteId: string, kind: OutputKind, includeSummary = false) {
  const result: Pick<ManusResearchResult, "summary" | "files"> = { summary: "", files: [] };
  for await (const data of outputPages(secret, remoteId, "task.listMessages")) {
    if (data.task_id !== remoteId || !Array.isArray(data.messages)) throw new ManusError("invalid_response");
    for (const event of data.messages) {
      const message = record(event);
      if (message.type !== "assistant_message") continue;
      const { content, attachments } = record(message.assistant_message);
      if (includeSummary && !result.summary && typeof content === "string" && !containsKey(content, secret)) {
        result.summary = content.trim().slice(0, 24_000);
      }
      if (!Array.isArray(attachments)) continue;
      for (const item of attachments) {
        const file = outputFile(item, secret, kind);
        if (file && result.files.length < 10 && !result.files.some(f => f.name === file.name)) result.files.push(file);
      }
    }
    if (result.files.length && (!includeSummary || result.summary)) break;
  }
  return result;
}

export async function readResearch(key: string, remoteId: string): Promise<ManusResearchResult> {
  const secret = taskCredentials(key, remoteId);
  const detail = await request(secret, "task.detail", new URLSearchParams({ task_id: remoteId }));
  const task = record(detail.task);
  if (task.id !== remoteId) throw new ManusError("invalid_response");
  const status = taskStatus(task);
  const output = status === "running" || status === "failed"
    ? { summary: "", files: [] } : await researchMessages(secret, remoteId, "workbook", true);
  return { status, taskUrl: taskPage(remoteId), ...output };
}

async function libraryWorkbook(secret: string, remoteId: string) {
  for await (const page of outputPages(secret, remoteId, "artifact.list")) {
    if (!Array.isArray(page.data)) throw new ManusError("invalid_response");
    for (const row of page.data) {
      const item = record(row);
      if (item.task_id !== remoteId) throw new ManusError("invalid_response");
      if (item.type !== "spreadsheets") continue;
      const file = outputFile({ type: item.file_type, filename: item.filename, url: item.url }, secret, "workbook");
      if (file) return file;
    }
  }
  return null;
}

async function downloadOutput(url: string, limit: number, sizeError: ManusErrorCode): Promise<Buffer> {
  try {
    const response = await fetch(url, {
      ...proxyOptions(), method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ManusError("upstream");
    }
    return await readBytes(response, limit, sizeError);
  } catch (err) {
    if (err instanceof ManusError) throw err;
    throw new ManusError("network");
  }
}

export async function downloadResearchWorkbook(key: string, remoteId: string): Promise<{ filename: string; bytes: Buffer }> {
  const secret = taskCredentials(key, remoteId);
  // Ask for fresh signed URLs. Stored links can expire, and paths in message text are remote sandbox paths.
  const { files } = await researchMessages(secret, remoteId, "workbook");
  const file = files[0] ?? await libraryWorkbook(secret, remoteId);
  if (!file) throw new ManusError("no_workbook");
  return { filename: file.name, bytes: await downloadOutput(file.url, MAX_WORKBOOK_BYTES, "workbook_too_large") };
}

export async function downloadResearchReport(key: string, remoteId: string): Promise<{ filename: string; text: string }> {
  const secret = taskCredentials(key, remoteId);
  const { files } = await researchMessages(secret, remoteId, "report");
  const file = files[0];
  if (!file) throw new ManusError("no_report");
  const bytes = await downloadOutput(file.url, reportLimit, "report_too_large");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim() || containsKey(text, secret)) throw new ManusError("invalid_response");
    return { filename: file.name, text };
  } catch { throw new ManusError("invalid_response"); }
}
