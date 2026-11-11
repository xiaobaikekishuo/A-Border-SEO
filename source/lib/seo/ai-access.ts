import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { fetchPublic, USER_AGENT } from "@/lib/crawler/engine";
import { ROBOTS_MAX_BYTES } from "@/lib/crawler/robots";
import { ContentError } from "@/lib/content-planner/http";
import { siteUrl } from "@/lib/content-planner/schema";
import { RateLimiter } from "@/lib/rate-limit";
import { assembleAccessReport, classifyRobots, decodeRobots, type RobotsEvidence } from "./ai-access-rules";
import type { AiAccessReason, AiAccessReport, AiAccessWarning } from "./ai-access-types";

export { classifyRobots, contentPreferences, decodeRobots, evaluateAiRobots, type RobotsEvidence } from "./ai-access-rules";

const TIMEOUT_MS = 15_000;
const limiter = new RateLimiter(6);
const active = new Set<string>();
const requestSchema = z.object({ url: z.string().trim().url().max(2048) }).strict();

class ProbeError extends Error {
  constructor(readonly reason: AiAccessReason) { super(reason); }
}

/** Up to `limit` bytes of the body; the rest is not read. */
async function readUpTo(res: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

export async function fetchAiRobots(url: string): Promise<RobotsEvidence> {
  const robotsUrl = new URL("/robots.txt", url).href;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | null = null;
  let contentType: string | null = null;
  let finalUrl: string | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProbeError("TIMEOUT")); }, TIMEOUT_MS);
  });
  const request = async (): Promise<RobotsEvidence> => {
    // Redirects are followed like a crawler does (at most 5 hops), to other public hosts too;
    // fetchPublic refuses private addresses on every hop. Credentials in a URL are refused.
    const response = await fetchPublic(robotsUrl, { "User-Agent": USER_AGENT, Accept: "text/plain,*/*;q=0.5" }, {
      signal: controller.signal,
      guard: async next => {
        const hop = new URL(next);
        if (hop.username || hop.password) throw new ProbeError("FETCH_FAILED");
      },
    });
    try {
      status = response.res.status;
      finalUrl = response.finalUrl;
      contentType = response.res.headers.get("content-type")?.slice(0, 200) ?? null;
      const redirected: AiAccessWarning[] = finalUrl !== robotsUrl ? ["ROBOTS_REDIRECTED"] : [];
      if (!response.res.ok) {
        await response.res.body?.cancel().catch(() => {});
        return { url: robotsUrl, finalUrl, status, contentType, ...classifyRobots(status, contentType, "", redirected) };
      }
      let read: { bytes: Uint8Array; truncated: boolean };
      try { read = await readUpTo(response.res, ROBOTS_MAX_BYTES); }
      catch (error) {
        if (response.timedOut() || controller.signal.aborted) throw new ProbeError("TIMEOUT");
        throw error;
      }
      const decoded = decodeRobots(read.bytes, read.truncated);
      return { url: robotsUrl, finalUrl, status, contentType, ...classifyRobots(status, contentType, decoded.text, [...redirected, ...decoded.warnings]) };
    } finally { response.done(); }
  };
  try { return await Promise.race([request(), deadline]); }
  catch (error) {
    if (error instanceof Error && /^Too many redirects/.test(error.message)) {
      return { url: robotsUrl, finalUrl, status, contentType, outcome: "UNAVAILABLE", reason: "ROBOTS_TOO_MANY_REDIRECTS", parsed: null, warnings: [] };
    }
    const reason = error instanceof ProbeError ? error.reason : error instanceof Error && /^Timed out after /.test(error.message) ? "TIMEOUT" : "FETCH_FAILED";
    return { url: robotsUrl, finalUrl, status, contentType, outcome: "UNKNOWN", reason, parsed: null, warnings: [] };
  } finally { if (timer) clearTimeout(timer); }
}

/** The report for fetched evidence, with this check's limits. */
export function buildAccessReport(siteId: string, url: string, evidence: RobotsEvidence, page: AiAccessReport["page"], now = new Date()): AiAccessReport {
  return assembleAccessReport(siteId, url, evidence, page, { robotsMaxBytes: ROBOTS_MAX_BYTES, timeoutMs: TIMEOUT_MS }, now);
}

/** Explicit, rate-limited inspection for an owned site's origin. Never generates content or changes site state. */
export async function probeAiAccess(db: PrismaClient, userId: string | null | undefined, siteId: string, raw: unknown): Promise<AiAccessReport> {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
  if (!site) throw new ContentError("Not found", 404);
  const { url: input } = requestSchema.parse(raw);
  let url: string;
  try {
    if (!/^https?:\/\//i.test(input)) throw new Error();
    url = siteUrl(input, site.domain)!;
    if (!url || url.length > 2048) throw new Error();
  } catch { throw new ContentError("URL must belong to this site's origin", 400); }
  const activeKey = `${userId}\0${site.id}`;
  if (active.has(activeKey)) throw new ContentError("An access check is already running for this site", 429);
  if (!limiter.hit(userId).ok) throw new ContentError("Too many access checks. Wait a minute and retry.", 429);
  active.add(activeKey);
  try {
    const crawl = await db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true } });
    const saved = crawl ? await db.auditPage.findFirst({ where: { crawlId: crawl.id, url }, select: { url: true, statusCode: true, robotsMeta: true, xRobotsTag: true, indexable: true } }) : null;
    const evidence = await fetchAiRobots(url);
    const page = saved ? { source: "SAVED_CRAWL" as const, capturedAt: crawl?.finishedAt?.toISOString() ?? null, url: saved.url, statusCode: saved.statusCode, robotsMeta: saved.robotsMeta?.slice(0, 1500) ?? null, xRobotsTag: saved.xRobotsTag?.slice(0, 1500) ?? null, indexable: saved.indexable } : null;
    return buildAccessReport(site.id, url, evidence, page);
  } finally { active.delete(activeKey); }
}
