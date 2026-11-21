import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ownedSite } from "@/lib/content-planner/data";
import { ContentError } from "@/lib/content-planner/http";
import { isResearchLanguage, RESEARCH_LANGUAGE_VALUES, RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import { hostedWorkerStatus } from "@/lib/hosted/worker";
import { storedRows } from "@/lib/manus/templates";
import { OUTREACH_LIMITS } from "../tools/schema";
import {
  AUTOMATION_SELECT, CAP_OF, DEFAULT_CAPS, FILLERS, fillSite, freshMetaCandidates, latestRankRun, LIVE_ITEM, META_ITEM_MAX, poolPreview, PREVIEW_TOPICS,
  schemaKey, schemaPages, SOURCE_OF, startMarkers, storedMarkers, storedStatuses, urlKey, type Filler, type FillerPreview, type FillerStatuses,
} from "./fill";
import { itemPayloadSchemas, itemTitle, poolServerEnabled, PRIORITY, type ItemKind, type PoolSource } from "./items";
import { MODEL_ID, poolPolicy, READING_MAX_AGE_MS, REASONING_EFFORTS, storedLimits, storedModels, windowsOf, type LimitWindow, type PolicyReason, type WorkerLimits, type WorkerModel } from "./limits";
import { DEFAULT_ROUTING, routingFrom, type Routing } from "./routing";
import { utcDayStart, waitingReview } from "./queue";

/*
 * The background pool as the owner sees and sets it (Codex workbench page):
 * the worker's allowance reading and what it allows now, the owner's
 * reserves and per-task models, what fills this site's pool and what each
 * filler found, the items themselves, and work queued by hand.
 */

type Db = PrismaClient;

export type PoolItemView = {
  id: string; source: string; kind: string; title: string; status: string; reason: string | null;
  jobId: string | null; jobStatus: string | null; jobError: string | null; reviewedAt: string | null;
  createdAt: string; startedAt: string | null;
};
export type AlertsScope = "drops" | "all";
export type AutomationView = Record<Filler, boolean> & { caps: Record<Filler, number>; alertsScope: AlertsScope };
export type PoolView = {
  serverEnabled: boolean;
  /** The worker's last reading; short: the 5-hour window, long: the weekly one; stale: too old to start work on. */
  reading: { limits: WorkerLimits | null; short: LimitWindow | null; long: LimitWindow | null; readAt: string | null; stale: boolean;
    error: string | null; models: WorkerModel[]; routing: boolean } | null;
  policy: { ok: true } | { ok: false; reason: PolicyReason | "pool_off" | "review_cap" | "server_off"; resumeAt: string | null };
  settings: { enabled: boolean; shortReserve: number; weeklyReserve: number; reviewCap: number; language: string; routing: Routing };
  automation: AutomationView;
  /** What each filler found at its last check, and the tasks of each kind started today on this site. */
  fillers: { status: FillerStatuses; startedToday: Record<Filler, number>; filledAt: string | null };
  counts: { pending: number; waitingReview: number; startedToday: number };
  missingSchema: number;
  items: PoolItemView[];
  /** Only when asked for (GET ?preview=1): what each filler would find now. */
  preview?: FillerPreview;
};

const SETTING_DEFAULTS = { enabled: false, shortReserve: 30, weeklyReserve: 10, reviewCap: 20, language: "zh-CN" };
const SWITCHES_OFF = Object.fromEntries(FILLERS.map(filler => [filler, false])) as Record<Filler, boolean>;

async function latestCrawlId(db: Pick<PrismaClient, "crawl">, siteId: string) {
  return (await db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } }))?.id ?? null;
}

type AutomationRow = Record<Filler, boolean> & Record<(typeof CAP_OF)[Filler], number> & { alertsScope: string };
export function automationView(row: AutomationRow | null): AutomationView {
  if (!row) return { ...SWITCHES_OFF, caps: { ...DEFAULT_CAPS }, alertsScope: "drops" };
  const caps = Object.fromEntries(FILLERS.map(filler => [filler, row[CAP_OF[filler]] ?? DEFAULT_CAPS[filler]])) as Record<Filler, number>;
  const switches = Object.fromEntries(FILLERS.map(filler => [filler, row[filler]])) as Record<Filler, boolean>;
  return { ...switches, caps, alertsScope: row.alertsScope === "all" ? "all" : "drops" };
}

export async function getPoolView(db: Db, userId: string | undefined | null, siteId: string, now = new Date(), options: { preview?: boolean } = {}): Promise<PoolView> {
  const site = await ownedSite(db, userId, siteId);
  const [setting, automation, worker, items, pending, started, crawlId] = await Promise.all([
    db.aiPoolSetting.findUnique({ where: { userId: userId! } }),
    db.aiAutomation.findUnique({ where: { siteId: site.id } }),
    hostedWorkerStatus(db, userId!),
    db.aiBacklogItem.findMany({ where: { siteId: site.id }, orderBy: [{ updatedAt: "desc" }], take: 60,
      include: { job: { select: { status: true, error: true } } } }),
    db.aiBacklogItem.count({ where: { siteId: site.id, status: "PENDING" } }),
    db.aiBacklogItem.groupBy({ by: ["source"], where: { siteId: site.id, status: "STARTED", startedAt: { gte: utcDayStart(now) } }, _count: { _all: true } }),
    latestCrawlId(db, site.id),
  ]);
  const waiting = await waitingReview(db, userId!);
  const missingSchema = crawlId ? await db.auditPage.count({ where: { crawlId, hasSchema: false, statusCode: 200, indexable: true } }) : 0;
  const settings = { ...SETTING_DEFAULTS, ...(setting ? { enabled: setting.enabled, shortReserve: setting.shortReserve, weeklyReserve: setting.weeklyReserve,
    reviewCap: setting.reviewCap, language: setting.language } : {}), routing: setting ? routingFrom(setting) : DEFAULT_ROUTING };
  const limits = storedLimits(worker?.limits);
  const readAt = worker?.limitsAt ?? null;
  const serverEnabled = poolServerEnabled();
  const policyNow = poolPolicy(limits, readAt, now, settings);
  const policy: PoolView["policy"] = !serverEnabled ? { ok: false, reason: "server_off", resumeAt: null }
    : !settings.enabled ? { ok: false, reason: "pool_off", resumeAt: null }
    : !policyNow.ok ? { ok: false, reason: policyNow.reason, resumeAt: policyNow.resumeAt?.toISOString() ?? null }
    : waiting >= settings.reviewCap ? { ok: false, reason: "review_cap", resumeAt: null } : { ok: true };
  const bySource = new Map(started.map(row => [row.source, row._count._all]));
  const startedToday = Object.fromEntries(FILLERS.map(filler => [filler, bySource.get(SOURCE_OF[filler]) ?? 0])) as Record<Filler, number>;
  const preview = options.preview ? await poolPreview(db, site, automation, now) : undefined;
  return {
    serverEnabled,
    reading: worker ? { limits, ...(limits ? windowsOf(limits) : { short: null, long: null }), readAt: readAt?.toISOString() ?? null,
      stale: !readAt || now.getTime() - readAt.getTime() > READING_MAX_AGE_MS, error: worker.limitsError ?? null,
      models: storedModels(worker.models), routing: (worker.capabilities ?? []).includes("routing-v1") } : null,
    policy, settings,
    automation: automationView(automation),
    fillers: { status: storedStatuses(automation?.status), startedToday, filledAt: automation?.filledAt?.toISOString() ?? null },
    counts: { pending, waitingReview: waiting, startedToday: FILLERS.reduce((sum, filler) => sum + startedToday[filler], 0) },
    missingSchema,
    items: items.sort((a, b) => order(a) - order(b) || (a.status === "PENDING" ? b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime() : b.updatedAt.getTime() - a.updatedAt.getTime()))
      .map(item => ({ id: item.id, source: item.source, kind: item.kind, title: item.title, status: item.status, reason: item.reason, jobId: item.jobId,
        jobStatus: item.job?.status ?? null, jobError: item.job?.error ?? null, reviewedAt: item.reviewedAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(), startedAt: item.startedAt?.toISOString() ?? null })),
    ...(preview ? { preview } : {}),
  };
}
// Running first, then waiting, then finished results, then the rest.
function order(item: { status: string; job: { status: string } | null; reviewedAt: Date | null }) {
  if (item.status === "STARTED" && (item.job?.status === "QUEUED" || item.job?.status === "RUNNING")) return 0;
  if (item.status === "PENDING") return 1;
  if (item.status === "STARTED" && item.job?.status === "SUCCEEDED" && !item.reviewedAt) return 2;
  return 3;
}

const effort = z.enum(REASONING_EFFORTS).nullable();
const tier = z.object({ model: z.string().regex(MODEL_ID).nullable(), reasoning: effort }).strict();
const cap = z.number().int().min(1).max(50);
const saveSchema = z.object({
  settings: z.object({
    enabled: z.boolean(), shortReserve: z.number().int().min(10).max(90), weeklyReserve: z.number().int().min(5).max(50),
    reviewCap: z.number().int().min(5).max(200), language: z.enum(RESEARCH_LANGUAGE_VALUES),
    routing: z.object({ light: tier, main: tier }).strict(),
  }).strict().optional(),
  automation: z.object({
    rankings: z.boolean(), alerts: z.boolean(), meta: z.boolean(), schema: z.boolean(), clusters: z.boolean(), briefs: z.boolean(),
    caps: z.object({ rankings: cap, alerts: cap, meta: cap, schema: cap, clusters: cap, briefs: cap }).strict(),
    alertsScope: z.enum(["drops", "all"]),
  }).strict().optional(),
}).strict();

/** Saves the owner's pool settings and this site's fillers; a filler just turned on looks at the site right away. */
export async function savePool(db: Db, userId: string | undefined | null, siteId: string, body: unknown, now = new Date()) {
  const site = await ownedSite(db, userId, siteId);
  const input = saveSchema.parse(body);
  if (input.settings) {
    const { routing, ...rest } = input.settings;
    const data = { ...rest, lightModel: routing.light.model, lightReasoning: routing.light.reasoning, mainModel: routing.main.model, mainReasoning: routing.main.reasoning };
    await db.aiPoolSetting.upsert({ where: { userId: userId! }, create: { userId: userId!, ...data }, update: data });
  }
  if (input.automation) {
    const { caps, ...switches } = input.automation;
    const current = await db.aiAutomation.findUnique({ where: { siteId: site.id } });
    const markers = await startMarkers(db, site.id, storedMarkers(current?.markers), {
      rankings: switches.rankings && !current?.rankings, alerts: switches.alerts && !current?.alerts }, now);
    const capColumns = Object.fromEntries(FILLERS.map(filler => [CAP_OF[filler], caps[filler]])) as Record<(typeof CAP_OF)[Filler], number>;
    const data = { ...switches, ...capColumns, markers: markers as Prisma.InputJsonValue, filledAt: null };
    const saved = await db.aiAutomation.upsert({ where: { siteId: site.id }, create: { siteId: site.id, ...data }, update: data, select: AUTOMATION_SELECT });
    const setting = await db.aiPoolSetting.findUnique({ where: { userId: userId! }, select: { enabled: true, language: true } });
    if (setting?.enabled) {
      try { await fillSite(db, site, saved, isResearchLanguage(setting.language) ? setting.language : "zh-CN", now); }
      catch (error) { console.error("[pool] fill failed:", error instanceof Error ? error.message : error); }
    }
  }
  return getPoolView(db, userId, siteId, now);
}

const id = z.string().min(1).max(200);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fillNow") }).strict(),
  z.object({ action: z.literal("reviewLatestRun") }).strict(),
  z.object({ action: z.literal("batchSchema") }).strict(),
  z.object({ action: z.literal("batchMeta") }).strict(),
  z.object({ action: z.literal("batchBriefs") }).strict(),
  z.object({ action: z.literal("batchLocalize"), pageIds: z.array(id).min(1).max(20), language: z.enum(RESEARCH_LANGUAGE_VALUES),
    location: z.number().int().refine(value => RESEARCH_LOCATIONS.some(item => item.value === value)) }).strict(),
  z.object({ action: z.literal("batchOutreach"), taskId: z.string().trim().min(1).max(100), senderName: z.string().trim().min(1).max(80),
    senderRole: z.string().trim().max(160).default(""), offer: z.string().trim().min(1).max(1500), offerPageId: id.optional(),
    language: z.enum(RESEARCH_LANGUAGE_VALUES), instructions: z.string().trim().max(6000).default("") }).strict(),
  z.object({ action: z.literal("cancel"), itemId: id }).strict(),
  z.object({ action: z.literal("reviewed"), itemId: id }).strict(),
  z.object({ action: z.literal("reviewedAll") }).strict(),
]);
export const BATCH_SCHEMA_MAX = 50;
export const BATCH_BRIEF_MAX = 30;

type QueueItem = { source: PoolSource; kind: ItemKind; title: string; payload: Record<string, unknown>; dedupeKey: string; priority: number };
export function chunk<T>(list: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let start = 0; start < list.length; start += size) parts.push(list.slice(start, start + size));
  return parts;
}

/**
 * Queues work by hand. An item already waiting, running or done is left as
 * it is (existing); one that was skipped, canceled or failed waits again.
 */
export async function queueItems(db: Db, siteId: string, items: QueueItem[], now: Date): Promise<{ queued: number; existing: number }> {
  if (!items.length) return { queued: 0, existing: 0 };
  return db.$transaction(async tx => {
    const found = await tx.aiBacklogItem.findMany({ where: { siteId, dedupeKey: { in: items.map(item => item.dedupeKey) } },
      select: { id: true, dedupeKey: true, status: true, job: { select: { status: true } } } });
    const byKey = new Map(found.map(item => [item.dedupeKey, item]));
    const create: QueueItem[] = [];
    let queued = 0, existing = 0;
    for (const item of items) {
      const old = byKey.get(item.dedupeKey);
      if (!old) { create.push(item); continue; }
      const again = old.status === "SKIPPED" || old.status === "CANCELED" || (old.status === "STARTED" && old.job?.status === "FAILED");
      if (!again) { existing++; continue; }
      await tx.aiBacklogItem.update({ where: { id: old.id }, data: { source: item.source, kind: item.kind, title: item.title, payload: item.payload as Prisma.InputJsonValue,
        priority: item.priority, status: "PENDING", reason: null, jobId: null, startedAt: null, reviewedAt: null, createdAt: now } });
      queued++;
    }
    if (create.length) {
      const created = await tx.aiBacklogItem.createMany({ skipDuplicates: true,
        data: create.map(item => ({ siteId, ...item, payload: item.payload as Prisma.InputJsonValue })) });
      queued += created.count;
      existing += create.length - created.count;
    }
    return { queued, existing };
  }, { timeout: 20000 });
}

/** Keys of these items that are still in the pool (waiting, or a task that did not fail). */
async function liveKeys(db: Db, siteId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.aiBacklogItem.findMany({ where: { siteId, dedupeKey: { in: keys }, ...LIVE_ITEM }, select: { dedupeKey: true } });
  return new Set(rows.map(row => row.dedupeKey));
}

/**
 * Work queued by hand (checking the fillers now, a review of the latest rank
 * check, batches), canceling a waiting item and marking results as reviewed.
 * `enabled` in a reply: whether the pool runs, so the page can say that
 * queued work waits until it is turned on.
 */
export async function runPoolAction(db: Db, userId: string | undefined | null, siteId: string, body: unknown, now = new Date()) {
  const site = await ownedSite(db, userId, siteId);
  const action = actionSchema.parse(body);
  const setting = await db.aiPoolSetting.findUnique({ where: { userId: userId! }, select: { language: true, enabled: true } });
  const language = setting && isResearchLanguage(setting.language) ? setting.language : "zh-CN";
  const enabled = poolServerEnabled() && !!setting?.enabled;
  const batch = (kind: ItemKind, title: string, payload: Record<string, unknown>, dedupeKey: string, priority: number = PRIORITY.BATCH): QueueItem =>
    ({ source: "BATCH", kind, title, payload: itemPayloadSchemas[kind].parse(payload) as Record<string, unknown>, dedupeKey, priority });

  switch (action.action) {
    case "fillNow": {
      const automation = await db.aiAutomation.findUnique({ where: { siteId: site.id }, select: AUTOMATION_SELECT });
      if (!automation || !FILLERS.some(filler => automation[filler])) return { added: 0, status: {} as FillerStatuses, enabled };
      return { ...(await fillSite(db, site, automation, language, now, true)), enabled };
    }
    case "reviewLatestRun": {
      const run = await latestRankRun(db, site.id);
      if (!run) throw new ContentError("No finished rank check yet", 409);
      const day = (run.finishedAt ?? now).toISOString().slice(0, 10);
      // The same key as the filler's, so the same check is never reviewed twice.
      const item = batch("SEO_FIX_PLAN", itemTitle.rankingsLatest(language, day), { scope: "rankings" }, `rankings:${run.id}`, PRIORITY.RANKINGS);
      return { ...(await queueItems(db, site.id, [item], now)), enabled };
    }
    case "batchSchema": {
      const { crawl, pages } = await schemaPages(db, site, now);
      if (!crawl) throw new ContentError("Run a crawl first", 409);
      const keyed = pages.map(page => ({ page, dedupeKey: schemaKey(page, crawl.id) }));
      const live = await liveKeys(db, site.id, keyed.map(entry => entry.dedupeKey));
      const open = keyed.filter(entry => !live.has(entry.dedupeKey));
      const items = open.slice(0, BATCH_SCHEMA_MAX).map(({ page, dedupeKey }) => batch("SCHEMA_MARKUP", itemTitle.schema(language, page.title || page.url, true), { url: page.url }, dedupeKey));
      const result = await queueItems(db, site.id, items, now);
      return { queued: result.queued, existing: live.size + result.existing, remaining: open.length - items.length, enabled };
    }
    case "batchMeta": {
      // Every low-CTR page not rewritten in the last 28 days and not waiting already, 20 to a task.
      const { pages } = await freshMetaCandidates(db, site, now);
      const parts = chunk(pages.map(page => page.url), META_ITEM_MAX);
      const day = now.toISOString().slice(0, 10);
      const items = parts.map((urls, index) => batch("META_REWRITE", itemTitle.metaBatch(language, index + 1, parts.length, urls.length), { urls },
        `meta-batch:${day}:${urlKey(urls.join("\n")).slice(0, 12)}`));
      return { ...(await queueItems(db, site.id, items, now)), pages: pages.length, enabled };
    }
    case "batchBriefs": {
      const topics = await db.contentCluster.findMany({ where: { siteId: site.id, status: "PLANNED", brief: { equals: Prisma.DbNull } }, orderBy: { createdAt: "asc" },
        take: PREVIEW_TOPICS, select: { id: true, title: true } });
      const live = await liveKeys(db, site.id, topics.map(topic => `brief:${topic.id}`));
      const open = topics.filter(topic => !live.has(`brief:${topic.id}`));
      const items = open.slice(0, BATCH_BRIEF_MAX).map(topic => batch("TOPIC_BRIEF", itemTitle.brief(language, topic.title, true), { clusterId: topic.id }, `brief:${topic.id}`));
      const result = await queueItems(db, site.id, items, now);
      return { queued: result.queued, existing: live.size + result.existing, remaining: open.length - items.length, enabled };
    }
    case "batchLocalize": {
      const crawlId = await latestCrawlId(db, site.id);
      const pages = crawlId ? await db.auditPage.findMany({ where: { crawlId, id: { in: action.pageIds } }, select: { url: true, title: true, articleText: true } }) : [];
      const usable = pages.filter(page => (page.articleText ?? "").trim().length >= 100);
      const market = RESEARCH_LOCATIONS.find(item => item.value === action.location)!;
      const items = usable.map(page => batch("LOCALIZE_ARTICLE", itemTitle.localize(language, page.title || page.url, language.startsWith("zh") ? market.zh : market.en),
        { url: page.url, language: action.language, location: action.location }, `localize:${urlKey(page.url)}:${action.language}:${action.location}`));
      return { ...(await queueItems(db, site.id, items, now)), unusable: action.pageIds.length - usable.length, enabled };
    }
    case "batchOutreach": {
      // All prospects of a finished Manus link prospect task, 10 to a task, with the sender details given once.
      const task = await db.manusResearchTask.findFirst({ where: { id: action.taskId, siteId: site.id, kind: "LINK_PROSPECTS" }, select: { status: true, rows: true } });
      const rows = task?.status === "completed" ? storedRows("LINK_PROSPECTS", task.rows) : [];
      if (!rows.length) throw new ContentError("outreach_task_unavailable", 409);
      let offerUrl: string | null = null;
      if (action.offerPageId) {
        const crawlId = await latestCrawlId(db, site.id);
        const page = crawlId ? await db.auditPage.findFirst({ where: { id: action.offerPageId, crawlId }, select: { url: true } }) : null;
        if (!page) throw new ContentError("Page not found in this site's latest completed crawl", 404);
        offerUrl = page.url;
      }
      const details = { senderName: action.senderName, senderRole: action.senderRole, offer: action.offer, offerUrl, language: action.language, instructions: action.instructions };
      const tag = urlKey(JSON.stringify(details)).slice(0, 12);
      const parts = chunk(rows.map((_, index) => index), OUTREACH_LIMITS.rows);
      const items = parts.map((part, index) => batch("OUTREACH_EMAILS", itemTitle.outreach(language, index + 1, parts.length, part.length),
        { taskId: action.taskId, rows: part, ...details }, `outreach:${action.taskId}:${tag}:${index + 1}`));
      return { ...(await queueItems(db, site.id, items, now)), prospects: rows.length, enabled };
    }
    case "cancel": {
      const changed = await db.aiBacklogItem.updateMany({ where: { id: action.itemId, siteId: site.id, status: "PENDING" }, data: { status: "CANCELED", reason: "canceled" } });
      if (!changed.count) throw new ContentError("Only waiting items can be canceled", 409);
      return { ok: true };
    }
    case "reviewed": {
      const changed = await db.aiBacklogItem.updateMany({ where: { id: action.itemId, siteId: site.id, status: "STARTED", reviewedAt: null }, data: { reviewedAt: now } });
      return { ok: true, changed: changed.count };
    }
    case "reviewedAll": {
      const changed = await db.aiBacklogItem.updateMany({ where: { siteId: site.id, status: "STARTED", reviewedAt: null, job: { status: { in: ["SUCCEEDED", "FAILED"] } } }, data: { reviewedAt: now } });
      return { ok: true, changed: changed.count };
    }
  }
}
