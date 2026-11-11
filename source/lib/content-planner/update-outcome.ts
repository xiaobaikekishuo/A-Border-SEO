import { Prisma } from "@prisma/client";
import { dateWindow, getGscDateRange } from "@/lib/date-utils";
import { ContentError } from "./http";

type Db = Pick<Prisma.TransactionClient, "site" | "gscSyncCoverage" | "page" | "contentCluster">;
export type OutcomeMetric = { gscProperty: string; start: string; end: string; clicks: number; impressions: number; position: number | null };
export type UpdateOutcome = { websiteUpdatedAt: string; baseline: OutcomeMetric | null; after: OutcomeMetric | null };
async function completeMetric(db: Db, siteId: string, url: string, range: { start: string; end: string }): Promise<OutcomeMetric | null> {
  const bounds = { gte: new Date(`${range.start}T00:00:00Z`), lte: new Date(`${range.end}T23:59:59.999Z`) };
  const site = await db.site.findUnique({ where: { id: siteId }, select: { gscProperty: true } });
  if (!site?.gscProperty) return null;
  const coverage = await db.gscSyncCoverage.count({ where: { siteId, gscProperty: site.gscProperty, pagesComplete: true, date: bounds } });
  if (coverage !== 28) return null;
  const rows = await db.page.findMany({ where: { siteId, url, date: bounds }, select: { clicks: true, impressions: true, position: true } });
  if (!rows.length) return null;
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  return { ...range, gscProperty: site.gscProperty, clicks, impressions, position: impressions ? rows.reduce((sum, row) => sum + row.impressions * row.position, 0) / impressions : null };
}
export async function recordWebsiteUpdate(db: Db, siteId: string, clusterId: string, now: Date) {
  const cluster = await db.contentCluster.findFirst({ where: { id: clusterId, siteId } });
  if (!cluster?.url || !cluster.optimization || typeof cluster.optimization !== "object" || Array.isArray(cluster.optimization)) throw new ContentError("Accept an article review before recording a website update", 409);
  const saved = cluster.optimization as Record<string, unknown>;
  if (saved.websiteUpdatedAt) return { ok: true, alreadyRecorded: true };
  const baseline = await completeMetric(db, siteId, cluster.url, getGscDateRange(28));
  await db.contentCluster.update({ where: { id: cluster.id }, data: { optimization: { ...saved, websiteUpdatedAt: now.toISOString(), baseline } as Prisma.InputJsonValue } });
  return { ok: true, alreadyRecorded: false };
}
export async function updateOutcome(db: Db, siteId: string, url: string | null, value: unknown): Promise<UpdateOutcome | null> {
  if (!url || !value || typeof value !== "object") return null;
  const saved = value as Record<string, unknown>;
  if (typeof saved.websiteUpdatedAt !== "string" || !Number.isFinite(Date.parse(saved.websiteUpdatedAt))) return null;
  const end = new Date(saved.websiteUpdatedAt); end.setUTCDate(end.getUTCDate() + 28);
  const range = dateWindow(28, end.toISOString().slice(0, 10));
  const after = range.end <= getGscDateRange(28).end ? await completeMetric(db, siteId, url, range) : null;
  const baseline = (saved.baseline ?? null) as OutcomeMetric | null;
  return { websiteUpdatedAt: saved.websiteUpdatedAt, baseline, after: baseline && after && baseline.gscProperty !== after.gscProperty ? null : after };
}
