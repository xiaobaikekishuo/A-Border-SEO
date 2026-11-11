import { recordWebsiteUpdate, updateOutcome } from "./update-outcome";
import { optimizationEvidence } from "./optimization-evidence";
import { startArticleReview, applyArticleReview } from "./article-review";
import { articleReviewSchema, articleReviewRequestSchema } from "./article-review-schema";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ContentError } from "./http";
import { actionSchema, briefSchema, dedupeKey, planSchema, siteUrl, validateBriefLinks } from "./schema";
import type { ContentBrief, ContentMetrics, ContentPlan, ContentWorkspace, MetricsPeriod } from "./types";
import { bulkUpdateContentClusters, importContentPages } from "./bulk";
import { storedFunnelCounts, presetFunnelCounts } from "./funnel";

export const LEASE_MS = 120_000;
export const WORKER_ONLINE_MS = 90_000;
export const RUN_TIMEOUT_MS = 10 * 60_000;
export const QUEUE_TIMEOUT_MS = 30 * 60_000;
type Tx = Prisma.TransactionClient;
export type PlannerDb = PrismaClient;
const json = (value: unknown) => value as Prisma.InputJsonValue;

export async function ownedSite(db: PlannerDb, userId: string | null | undefined, siteId: string) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
  if (!site) throw new ContentError("Not found", 404);
  return site;
}
async function ownedPillar(db: PlannerDb | Tx, siteId: string, pillarId: string) {
  const row = await db.contentPillar.findFirst({ where: { id: pillarId, siteId } });
  if (!row) throw new ContentError("Pillar not found", 404);
  return row;
}
async function ownedCluster(db: PlannerDb | Tx, siteId: string, clusterId: string) {
  const row = await db.contentCluster.findFirst({ where: { id: clusterId, siteId } });
  if (!row) throw new ContentError("Topic not found", 404);
  return row;
}
function checkedUrl(value: string | null | undefined, domain: string) {
  try { return siteUrl(value, domain); } catch (e) { throw new ContentError((e as Error).message); }
}
function checkedBrief(value: ContentBrief | null | undefined, domain: string) {
  try { return validateBriefLinks(value, domain); } catch (e) { throw new ContentError((e as Error).message); }
}
export async function expireContentJobs(db: PlannerDb, now = new Date(), siteId?: string) {
  return db.contentPlanJob.updateMany({
    where: { ...(siteId ? { siteId } : {}), OR: [
      { status: "QUEUED", createdAt: { lte: new Date(now.getTime() - QUEUE_TIMEOUT_MS) } },
      { status: "RUNNING", OR: [
        { leaseExpiresAt: { lte: now } }, { leaseExpiresAt: null },
        { startedAt: { lte: new Date(now.getTime() - RUN_TIMEOUT_MS) } },
      ] },
    ] },
    data: { status: "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null, finishedAt: now,
      error: "The local generation job timed out. No topics were imported. Start a new plan when the worker is online." },
  });
}
export function aggregateUrlMetrics(
  rows: { url: string; clicks: number; impressions: number; position: number }[], period: MetricsPeriod,
): Map<string, ContentMetrics> {
  const totals = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const sum = totals.get(row.url) ?? { clicks: 0, impressions: 0, weighted: 0 };
    sum.clicks += row.clicks; sum.impressions += row.impressions; sum.weighted += row.position * row.impressions;
    totals.set(row.url, sum);
  }
  return new Map([...totals].map(([url, sum]) => [url, {
    clicks: sum.clicks, impressions: sum.impressions,
    ctr: sum.impressions ? sum.clicks / sum.impressions : 0,
    position: sum.impressions ? sum.weighted / sum.impressions : null, period,
  }]));
}
export async function metricWindow(db: PlannerDb, siteId: string) {
  const latest = await db.page.findFirst({ where: { siteId }, orderBy: { date: "desc" }, select: { date: true } });
  if (!latest) return null;
  const end = new Date(latest.date); end.setUTCHours(23, 59, 59, 999);
  const start = new Date(latest.date); start.setUTCDate(start.getUTCDate() - 27); start.setUTCHours(0, 0, 0, 0);
  return { start, end, period: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) } };
}
const jobColumns = {
  id: true, pillarId: true, kind: true, request: true, topicCount: true, status: true, result: true, error: true, appliedAt: true,
  createdAt: true, startedAt: true, finishedAt: true,
} as const;
export async function getContentWorkspace(db: PlannerDb, userId: string, siteId: string, now = new Date()): Promise<ContentWorkspace> {
  const site = await ownedSite(db, userId, siteId);
  await expireContentJobs(db, now, siteId);
  const [pillars, jobs, worker, window, crawl] = await Promise.all([
    db.contentPillar.findMany({ where: { siteId }, orderBy: { createdAt: "asc" }, include: { clusters: { orderBy: { createdAt: "asc" } } } }),
    db.contentPlanJob.findMany({ where: { siteId }, orderBy: { createdAt: "desc" }, take: 20, select: jobColumns }),
    db.contentWorkerState.findFirst({ orderBy: { lastSeenAt: "desc" } }),
    metricWindow(db, siteId),
    db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" },
      select: { id: true, finishedAt: true, pagesFound: true, maxPages: true } }),
  ]);
  const urls = [...new Set(pillars.flatMap((p) => [p.url, ...p.clusters.map((c) => c.url)]).filter((url): url is string => !!url))];
  const rows = window && urls.length ? await db.page.findMany({
    where: { siteId, url: { in: urls }, date: { gte: window.start, lte: window.end } },
    select: { url: true, clicks: true, impressions: true, position: true },
  }) : [];
  const metrics = window ? aggregateUrlMetrics(rows, window.period) : new Map<string, ContentMetrics>();
  const [observedPages, observedLinks] = crawl && urls.length ? await Promise.all([
    db.auditPage.findMany({ where: { crawlId: crawl.id, url: { in: urls } }, select: { url: true } }),
    db.auditLink.findMany({ where: { crawlId: crawl.id, isInternal: true, sourceUrl: { in: urls } },
      select: { sourceUrl: true, targetUrl: true } }),
  ]) : [[], []];
  const seenPages = new Set(observedPages.map((p) => p.url));
  const seenLinks = new Set(observedLinks.map((link) => JSON.stringify([link.sourceUrl, link.targetUrl])));
  const outcomes = new Map(await Promise.all(pillars.flatMap(pillar => pillar.clusters).filter(cluster => cluster.optimization).map(async cluster => [cluster.id, await updateOutcome(db, siteId, cluster.url, cluster.optimization)] as const)));
  const parsed = (value: unknown) => { const result = briefSchema.safeParse(value); return result.success ? result.data : null; };
  return {
    site,
    pillars: pillars.map((p) => ({
      id: p.id, title: p.title, keyword: p.keyword, description: p.description, audience: p.audience, goal: p.goal,
      url: p.url, source: p.source, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
      searchVolume: null, performance: p.url ? metrics.get(p.url) ?? null : null,
      clusters: p.clusters.map((c) => ({
        id: c.id, pillarId: c.pillarId, title: c.title, keyword: c.keyword, funnel: c.funnel, intent: c.intent,
        contentType: c.contentType, status: c.status, url: c.url, scheduledFor: c.scheduledFor?.toISOString() ?? null,
        updateOutcome: outcomes.get(c.id) ?? null,
        optimization: optimizationEvidence(c.optimization, c.url, seenPages, seenLinks, crawl?.finishedAt ?? null),
        brief: parsed(c.brief), source: c.source, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
        searchVolume: null, performance: c.url ? metrics.get(c.url) ?? null : null,
        linkEvidence: p.url && c.url && crawl?.finishedAt ? {
          crawlAt: crawl.finishedAt.toISOString(), sampleLimited: crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages,
          pillarToCluster: seenLinks.has(JSON.stringify([p.url, c.url])), clusterToPillar: seenLinks.has(JSON.stringify([c.url, p.url])),
          sourceInSample: seenPages.has(p.url), targetInSample: seenPages.has(c.url),
        } : null,
      })),
    })),
    jobs: jobs.map(({ request, ...j }) => ({ ...j, funnelCounts: j.kind === "ARTICLE_REVIEW" ? undefined : storedFunnelCounts(request, j.topicCount), result: j.kind === "ARTICLE_REVIEW" ? null : j.result as ContentPlan | null,
      reviewResult: j.kind === "ARTICLE_REVIEW" ? articleReviewSchema.safeParse(j.result).data ?? null : null,
      reviewPages: j.kind === "ARTICLE_REVIEW" ? (articleReviewRequestSchema.safeParse(request).data?.pages ?? []).map(({ pageId, title, url, source }) => ({ pageId, title, url, source })) : [],
      appliedAt: j.appliedAt?.toISOString() ?? null, createdAt: j.createdAt.toISOString(),
      startedAt: j.startedAt?.toISOString() ?? null, finishedAt: j.finishedAt?.toISOString() ?? null })),
    worker: { online: !!worker && now.getTime() - worker.lastSeenAt.getTime() < WORKER_ONLINE_MS,
      lastSeenAt: worker?.lastSeenAt.toISOString() ?? null },
    metricsPeriod: window?.period ?? null,
  };
}

async function assertPillarIdle(db: PlannerDb | Tx, siteId: string, pillarId: string) {
  if (await db.contentPlanJob.count({ where: { siteId, pillarId, status: { in: ["QUEUED", "RUNNING"] } } })) {
    throw new ContentError("This pillar has an active generation job", 409);
  }
}
async function lockSite(tx: Tx, siteId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`);
}
export async function runContentAction(db: PlannerDb, userId: string, siteId: string, input: unknown, now = new Date()) {
  const site = await ownedSite(db, userId, siteId);
  const action = actionSchema.parse(input);
  await expireContentJobs(db, now, siteId);
  switch (action.action) {
    case "recordWebsiteUpdate": return db.$transaction(async tx => { await lockSite(tx, siteId); return recordWebsiteUpdate(tx, siteId, action.clusterId, now); });
    case "startArticleReview": return db.$transaction(async (tx) => {
      await lockSite(tx, siteId); return startArticleReview(tx, site, action.pageIds, action.pastedText);
    });
    case "applyArticleReview": return db.$transaction(async (tx) => {
      await lockSite(tx, siteId); return applyArticleReview(tx, site, action.jobId, action.pageIds, now);
    });
    case "importPages": return db.$transaction(async (tx) => {
      await lockSite(tx, siteId);
      return importContentPages(tx, site, action);
    });
    case "bulkUpdateClusters": return db.$transaction(async (tx) => {
      await lockSite(tx, siteId);
      return bulkUpdateContentClusters(tx, siteId, action);
    });
    case "createPillar": {
      const pillar = await db.contentPillar.create({ data: { ...action.data, siteId, url: checkedUrl(action.data.url, site.domain) } });
      return { ok: true, pillarId: pillar.id };
    }
    case "updatePillar": {
      await ownedPillar(db, siteId, action.pillarId);
      const data = { ...action.data, ...(action.data.url !== undefined ? { url: checkedUrl(action.data.url, site.domain) } : {}) };
      await db.contentPillar.updateMany({ where: { id: action.pillarId, siteId }, data });
      return { ok: true };
    }
    case "deletePillar": {
      return db.$transaction(async (tx) => {
        await lockSite(tx, siteId);
        await ownedPillar(tx, siteId, action.pillarId);
        await assertPillarIdle(tx, siteId, action.pillarId);
        await tx.contentPillar.deleteMany({ where: { id: action.pillarId, siteId } });
        return { ok: true };
      });
    }
    case "createCluster": {
      await ownedPillar(db, siteId, action.pillarId);
      const { brief, scheduledFor, ...fields } = action.data;
      await db.contentCluster.create({ data: {
        ...fields, siteId, pillarId: action.pillarId, dedupeKey: dedupeKey(fields.keyword),
        url: checkedUrl(fields.url, site.domain), scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        ...(brief ? { brief: json(checkedBrief(brief, site.domain)) } : {}),
      } });
      return { ok: true };
    }
    case "updateCluster": {
      await ownedCluster(db, siteId, action.clusterId);
      const { brief, scheduledFor, ...fields } = action.data;
      await db.contentCluster.updateMany({ where: { id: action.clusterId, siteId }, data: {
        ...fields, ...(fields.keyword !== undefined ? { dedupeKey: dedupeKey(fields.keyword) } : {}),
        ...(fields.url !== undefined ? { url: checkedUrl(fields.url, site.domain) } : {}),
        ...(scheduledFor !== undefined ? { scheduledFor: scheduledFor ? new Date(scheduledFor) : null } : {}),
        ...(brief !== undefined ? { brief: brief ? json(checkedBrief(brief, site.domain)) : Prisma.DbNull } : {}),
      } });
      return { ok: true };
    }
    case "deleteCluster": {
      await ownedCluster(db, siteId, action.clusterId);
      await db.contentCluster.deleteMany({ where: { id: action.clusterId, siteId } });
      return { ok: true };
    }
    case "startPlan": {
      return db.$transaction(async (tx) => {
        await lockSite(tx, siteId);
        await ownedPillar(tx, siteId, action.pillarId);
        if (await tx.contentPlanJob.count({ where: { siteId, status: { in: ["QUEUED", "RUNNING"] } } })) {
          throw new ContentError("A content plan is already queued or running for this site", 409);
        }
        const funnelCounts = action.funnelCounts ?? presetFunnelCounts(action.topicCount);
        const job = await tx.contentPlanJob.create({ data: { siteId, pillarId: action.pillarId, topicCount: action.topicCount, request: json({ funnelCounts }), activeKey: siteId }, select: jobColumns });
        return { ok: true, job };
      });
    }
    case "applyPlan": {
      return db.$transaction(async (tx) => {
        const job = await tx.contentPlanJob.findFirst({ where: { id: action.jobId, siteId } });
        if (!job || job.kind === "ARTICLE_REVIEW") throw new ContentError("Plan not found", 404);
        if (job.appliedAt) return { ok: true, imported: 0, updated: 0, alreadyApplied: true };
        if (job.status !== "SUCCEEDED") throw new ContentError("The plan is not ready to apply", 409);
        const plan = planSchema.parse(job.result);
        const indexes = [...new Set(action.topicIndexes)];
        if (indexes.some((i) => i >= plan.topics.length)) throw new ContentError("Selected topic index is out of range");
        const topics = indexes.map((i) => plan.topics[i]);
        const claimed = await tx.contentPlanJob.updateMany({ where: { id: job.id, siteId, appliedAt: null }, data: { appliedAt: now } });
        if (!claimed.count) return { ok: true, imported: 0, updated: 0, alreadyApplied: true };
        let updated = 0;
        if (action.updateExistingBriefs) {
          for (const topic of topics) {
            const changed = await tx.contentCluster.updateMany({
              where: { siteId, pillarId: job.pillarId, dedupeKey: dedupeKey(topic.keyword) },
              data: { brief: json(checkedBrief(topic.brief, site.domain)), source: "AI", updatedAt: now },
            });
            updated += changed.count;
          }
        }
        const result = await tx.contentCluster.createMany({ data: topics.map((topic) => ({
          siteId, pillarId: job.pillarId, title: topic.title, keyword: topic.keyword, dedupeKey: dedupeKey(topic.keyword),
          funnel: topic.funnel, intent: topic.intent, contentType: topic.contentType, status: "BRIEF_READY", source: "AI",
          brief: json(checkedBrief(topic.brief, site.domain)),
        })), skipDuplicates: true });
        return { ok: true, imported: result.count, updated, alreadyApplied: false };
      });
    }
    case "seedExample": return seedExample(db, site);
  }
}

async function seedExample(db: PlannerDb, site: { id: string; domain: string }) {
  if (new URL(`https://${site.domain.replace(/^https?:\/\//, "")}`).hostname !== "ssad.shop") {
    throw new ContentError("This example is available only for ssad.shop", 400);
  }
  return db.$transaction(async (tx) => {
    const pillar = await tx.contentPillar.upsert({ where: { siteId_seedKey: { siteId: site.id, seedKey: "apple-id-guide-v1" } }, update: {}, create: {
      siteId: site.id, seedKey: "apple-id-guide-v1", source: "EXAMPLE", title: "Apple ID 地区与使用指南", keyword: "Apple ID 地区",
      description: "演示支柱与主题集群。已有文章优先复核和更新，避免重复发布。", audience: "需要理解 Apple ID 地区与账户设置的中文用户",
      goal: "解释概念、比较选择并提供操作前检查清单；所有建议均需编辑核实。",
    } });
    const examples = [
      { title: "App Store 与 iCloud 区别", keyword: "App Store 与 iCloud 区别", funnel: "TOFU" as const, url: "https://ssad.shop/article/apple-id-app-store-vs-icloud" },
      { title: "Apple ID 地区怎么选", keyword: "Apple ID 地区选择", funnel: "MOFU" as const, url: "https://ssad.shop/article/apple-id-region-guide" },
      { title: "地区切换前检查", keyword: "Apple ID 地区切换前检查", funnel: "BOFU" as const, url: null },
    ];
    const result = await tx.contentCluster.createMany({ data: examples.map((topic) => ({
      ...topic, siteId: site.id, pillarId: pillar.id, dedupeKey: dedupeKey(topic.keyword), status: "BRIEF_READY", source: "EXAMPLE", intent: "信息查询与决策准备", contentType: "Guide",
      brief: json({
        summary: topic.url ? "复核并更新已有文章，避免新建重复内容。" : "为地区切换前的准备工作设计清晰的检查清单。",
        audience: "需要了解 Apple ID 地区与账户设置的中文用户", searchIntent: topic.keyword,
        angle: "区分账户概念、地区限制和操作前准备，优先引用经核实的官方说明。",
        outline: ["读者需要解决的问题", "概念与适用范围", "核实步骤与常见误区", "操作前检查和后续阅读"],
        keyPoints: ["区分 App Store 与 iCloud 的用途", "核实当前地区要求、订阅和余额规则", "保护账户凭据，不在文章中收集密码"],
        cta: "完成检查清单并查阅当前官方支持说明。",
        internalLinks: examples.filter((t) => t.url && t.url !== topic.url).map((t) => ({ target: t.url!, title: t.title, reason: "补充相关概念并减少重复解释" })),
        evidenceNotes: ["EXAMPLE：这是可编辑的演示简报，不是 AI 生成结果，也不是已核实的操作指导。", "已映射文章可用于复核更新；站内链接与现行官方要求仍需编辑确认。", "没有填入假设的搜索量、点击量或排名；指标仅在存在 GSC 数据时显示。"],
      }),
    })), skipDuplicates: true });
    return { ok: true, pillarId: pillar.id, imported: result.count };
  });
}
