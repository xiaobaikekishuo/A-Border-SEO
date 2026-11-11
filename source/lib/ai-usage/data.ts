import type { PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { buildUsageReport, type UsageProvider, type UsageTask } from "./report";
import { storedUsage } from "./schema";

function requestMetadata(raw: unknown): { provider: UsageProvider; model: string | null } {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) return { provider: "UNKNOWN", model: null };
  const request = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  // Missing provider is the legacy local CLI path, never an API-key inference.
  const provider = request.provider === "CHATGPT_APP" ? "CHATGPT_APP" : request.provider === undefined || request.provider === "CODEX_LOCAL" ? "CODEX_LOCAL" : "UNKNOWN";
  return { provider, model: typeof request.model === "string" && /^[a-zA-Z0-9._:/-]{1,100}$/.test(request.model) ? request.model : null };
}

export async function getAiUsage(db: PrismaClient, userId: string | undefined | null, days: number, siteId: string | null, now = new Date()) {
  if (!userId) throw new ContentError("Sign in required", 401);
  if (![7, 30, 90].includes(days)) throw new ContentError("days must be 7, 30 or 90");
  const sites = await db.site.findMany({ where: { userId, ...(siteId ? { id: siteId } : {}) }, select: { id: true, domain: true } });
  if (siteId && !sites.length) throw new ContentError("Site not found", 404);
  const where = { siteId: { in: sites.map(site => site.id) }, createdAt: { gte: new Date(now.getTime() - days * 86400000), lte: now } };
  const select = { id: true, siteId: true, kind: true, request: true, status: true, usage: true,
    createdAt: true, startedAt: true, finishedAt: true } as const;
  const [workbench, plans] = await Promise.all([
    db.aiWorkbenchJob.findMany({ where, select: { ...select, title: true } }),
    db.contentPlanJob.findMany({ where, select: { ...select, pillar: { select: { title: true } } } }),
  ]);
  const domains = new Map(sites.map(site => [site.id, site.domain]));
  const rows: UsageTask[] = [
    ...workbench.map(job => ({ ...job, title: job.title.slice(0, 200) })),
    ...plans.map(job => ({ ...job, title: job.pillar.title.slice(0, 200) })),
  ].map(job => ({ id: job.id, kind: job.kind, title: job.title, domain: domains.get(job.siteId)!, ...requestMetadata(job.request),
    status: job.status, usage: storedUsage(job.usage), createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null }));
  return buildUsageReport(rows, days, siteId, now);
}
