import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { siteUrl } from "@/lib/content-planner/schema";
import { getGscDateRange } from "@/lib/date-utils";
import { collectActionEvidence } from "../action-evidence";
import { metaRewriteCandidates, pageMetrics } from "../tools/meta-rewrite";
import { itemTitle, PRIORITY, type NewItem, type PoolSource } from "./items";

/*
 * What fills a site's background pool (AiAutomation). Each filler looks at
 * what is new since it last looked (markers), queues at most a few items and
 * records what it found (status), so the owner can see why something was or
 * was not queued:
 *   rankings  a finished rank check with notable moves: a ranking review
 *   alerts    a traffic or ranking drop alert (or any alert) fired since last time: a diagnosis
 *   meta      low-CTR pages that are new or got worse, checked daily: added to the waiting rewrite
 *   schema    a new crawl: structured data for pages without any, pages new since the previous crawl first
 *   clusters  once a month, with at least 10 search queries: search query clusters
 *   briefs    planned topics without a brief
 * A newer review, diagnosis or clustering replaces an older one still
 * waiting, and anything waiting for two weeks is dropped. poolPreview counts
 * what each filler would find right now, without queuing anything.
 */

export const FILLERS = ["rankings", "alerts", "meta", "schema", "clusters", "briefs"] as const;
export type Filler = (typeof FILLERS)[number];
export const SOURCE_OF: Record<Filler, PoolSource> = { rankings: "RANKINGS", alerts: "ALERTS", meta: "META", schema: "SCHEMA", clusters: "CLUSTERS", briefs: "BRIEF" };
export const CAP_OF = { rankings: "rankingsCap", alerts: "alertsCap", meta: "metaCap", schema: "schemaCap", clusters: "clustersCap", briefs: "briefsCap" } as const;
export const DEFAULT_CAPS: Record<Filler, number> = { rankings: 2, alerts: 2, meta: 1, schema: 10, clusters: 1, briefs: 5 };
type Caps = Partial<Record<(typeof CAP_OF)[Filler], number>> | null | undefined;
/** The daily limit of automatic tasks from a pool source on a site; work queued by hand (BATCH) has none. */
export function capOf(source: string, caps: Caps): number | null {
  const filler = FILLERS.find(name => SOURCE_OF[name] === source);
  if (!filler) return null;
  return caps?.[CAP_OF[filler]] ?? DEFAULT_CAPS[filler];
}
/** The alerts that lead to a diagnosis when alertsScope is "drops". */
export const DROP_ALERTS = ["TRAFFIC_DROP", "POSITION_CHANGE", "RANK_DROP"] as const;

/**
 * What a filler found the last time it looked. count: what it saw (pages,
 * keywords, topics); added: what it queued; lastAddedAt: when it last queued
 * anything, kept while later checks find nothing new.
 */
export const OUTCOMES = ["added", "merged", "already_queued", "not_notable", "no_new_run", "no_run", "none_fired", "no_change", "no_candidates", "no_new_crawl",
  "no_crawl", "none_missing", "pool_full", "done_this_month", "not_enough_queries", "none_waiting", "check_failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type FillerStatus = { checkedAt: string; outcome: Outcome; count: number; added: number; lastAddedAt?: string; lastAdded?: number };
export type FillerStatuses = Partial<Record<Filler, FillerStatus>>;

export type Markers = { rankRunId?: string; alertAt?: string; crawlId?: string; metaCheckedOn?: string; metaSeen?: Record<string, number>; clusterMonth?: string; clusterCheckedOn?: string };
export type Automation = { siteId: string; rankings: boolean; alerts: boolean; meta: boolean; schema: boolean; clusters: boolean; briefs: boolean;
  alertsScope?: string; markers: unknown; status?: unknown };
type Db = PrismaClient | Prisma.TransactionClient;
type Site = { id: string; domain: string };

export const SCHEMA_PER_CRAWL = 10;
export const PENDING_SCHEMA_MAX = 20;
export const PENDING_BRIEF_MAX = 5;
export const META_ITEM_MAX = 20;
export const MIN_CLUSTER_QUERIES = 10;
/** A page counts as worse when its CTR fell by this share since the last check. */
export const META_WORSE_BY = 0.2;
export const FILL_EVERY_MS = 10 * 60_000;
export const PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const REWRITE_COOLDOWN_MS = 28 * 24 * 60 * 60_000;
const REPLACEABLE: PoolSource[] = ["RANKINGS", "ALERTS", "CLUSTERS"];
const SEEN_MAX = 60;

/** A short, stable key part for a page URL (dedupe keys stay well under index limits). */
export function urlKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/** A page's structured data item: queued again only when its content changes. */
export function schemaKey(page: { url: string; contentHash: string | null }, crawlId: string): string {
  return `schema:${urlKey(page.url)}:${(page.contentHash ?? crawlId).slice(0, 64)}`;
}

export function storedMarkers(value: unknown): Markers {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Markers = {};
  for (const key of ["rankRunId", "alertAt", "crawlId", "metaCheckedOn", "clusterMonth", "clusterCheckedOn"] as const) {
    if (typeof raw[key] === "string" && (raw[key] as string).length <= 200) out[key] = raw[key] as string;
  }
  if (raw.metaSeen && typeof raw.metaSeen === "object" && !Array.isArray(raw.metaSeen)) {
    const seen = Object.entries(raw.metaSeen as Record<string, unknown>).filter((entry): entry is [string, number] =>
      entry[0].length <= 2048 && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0).slice(0, SEEN_MAX);
    out.metaSeen = Object.fromEntries(seen);
  }
  return out;
}

export function storedStatuses(value: unknown): FillerStatuses {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: FillerStatuses = {};
  for (const filler of FILLERS) {
    const raw = (value as Record<string, unknown>)[filler] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || typeof raw.checkedAt !== "string" || !(OUTCOMES as readonly string[]).includes(raw.outcome as string)) continue;
    out[filler] = { checkedAt: raw.checkedAt, outcome: raw.outcome as Outcome, count: Number(raw.count) || 0, added: Number(raw.added) || 0,
      ...(typeof raw.lastAddedAt === "string" ? { lastAddedAt: raw.lastAddedAt, lastAdded: Number(raw.lastAdded) || 0 } : {}) };
  }
  return out;
}

/** This check's statuses with when each filler last queued anything carried over from the previous ones. */
export function withLastAdded(previous: FillerStatuses, current: FillerStatuses): FillerStatuses {
  const out: FillerStatuses = {};
  for (const filler of FILLERS) {
    const state = current[filler];
    if (!state) continue;
    const rest: FillerStatus = { checkedAt: state.checkedAt, outcome: state.outcome, count: state.count, added: state.added };
    const before = previous[filler];
    out[filler] = state.outcome === "added" || state.outcome === "merged" ? { ...rest, lastAddedAt: state.checkedAt, lastAdded: state.added }
      : before?.lastAddedAt ? { ...rest, lastAddedAt: before.lastAddedAt, lastAdded: before.lastAdded ?? 0 } : rest;
  }
  return out;
}

/** A rank check row worth a review: a drop of 3 or more, a keyword that left the checked depth, a new ranking page, or a competitor moving up. */
export function notableRankRow(row: Record<string, unknown>): boolean {
  if (row.kind === "serpEntrant") return true;
  if (row.kind !== "rankChange") return false;
  const change = typeof row.change === "number" ? row.change : null;
  const left = typeof row.previousPosition === "number" && row.position === null;
  const moved = typeof row.url === "string" && typeof row.previousUrl === "string" && row.url !== row.previousUrl;
  return left || moved || (change !== null && change <= -3);
}
export function notableRankRows(rows: Record<string, unknown>[]): boolean {
  return rows.some(notableRankRow);
}
/** Keywords with notable moves and competitors that moved up, in a rank check's evidence rows. */
export function rankMoves(rows: Record<string, unknown>[]) {
  return {
    keywords: rows.filter(row => row.kind === "rankChange" && notableRankRow(row)).length,
    competitors: new Set(rows.filter(row => row.kind === "serpEntrant").map(row => String(row.competitor ?? row.domain ?? ""))).size,
  };
}

/**
 * Low-CTR pages worth a new rewrite: not seen at the last check, or with a
 * CTR at least 20% lower than then. `seen` for next time keeps the current CTRs.
 */
export function metaChanges(candidates: { url: string; ctr: number }[], seen: Record<string, number> | undefined) {
  const changed = candidates.filter(page => {
    const before = seen?.[page.url];
    return before === undefined || (before > 0 && page.ctr <= before * (1 - META_WORSE_BY));
  }).map(page => page.url);
  return { changed, seen: Object.fromEntries(candidates.slice(0, SEEN_MAX).map(page => [page.url, Math.round(page.ctr * 10_000) / 10_000])) };
}

/** Pages new since the previous crawl first, then the most search impressions. */
export function schemaOrder<T extends { url: string }>(pages: T[], impressions: Map<string, number>, previous: Set<string> | null): T[] {
  const isNew = (url: string) => previous !== null && !previous.has(url);
  return [...pages].sort((a, b) => Number(isNew(b.url)) - Number(isNew(a.url))
    || (impressions.get(b.url) ?? 0) - (impressions.get(a.url) ?? 0) || a.url.length - b.url.length || (a.url < b.url ? -1 : 1));
}

/**
 * Markers for a filler just turned on: rankings and alerts react to what
 * happens from now on; the others start with the latest data.
 */
export async function startMarkers(db: Db, siteId: string, current: Markers, turnedOn: { rankings: boolean; alerts: boolean }, now: Date): Promise<Markers> {
  const markers = { ...current };
  if (turnedOn.rankings) markers.rankRunId = (await latestRankRun(db, siteId))?.id ?? "";
  if (turnedOn.alerts) markers.alertAt = now.toISOString();
  return markers;
}

export function latestRankRun(db: Db, siteId: string) {
  return db.rankRun.findFirst({ where: { siteId, status: { in: ["SUCCEEDED", "PARTIAL"] }, finishedAt: { not: null } }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true } });
}

export async function rewrittenRecently(db: Db, siteId: string, now: Date): Promise<Set<string>> {
  const jobs = await db.aiWorkbenchJob.findMany({ where: { siteId, kind: "META_REWRITE", status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] }, createdAt: { gte: new Date(now.getTime() - REWRITE_COOLDOWN_MS) } },
    select: { request: true }, take: 50 });
  const urls = new Set<string>();
  for (const job of jobs) {
    const list = (job.request as { metaRewrite?: { urls?: unknown } } | null)?.metaRewrite?.urls;
    if (Array.isArray(list)) for (const url of list) if (typeof url === "string") urls.add(url);
  }
  // Pages already waiting in the pool for a rewrite count as taken too.
  const waiting = await db.aiBacklogItem.findMany({ where: { siteId, kind: "META_REWRITE", status: "PENDING" }, select: { payload: true }, take: 20 });
  for (const item of waiting) {
    const list = (item.payload as { urls?: unknown } | null)?.urls;
    if (Array.isArray(list)) for (const url of list) if (typeof url === "string") urls.add(url);
  }
  return urls;
}

/** Low-CTR candidates not rewritten in the last 28 days and not already waiting. */
export async function freshMetaCandidates(db: Db, site: Site, now: Date) {
  const [{ pages }, taken] = await Promise.all([metaRewriteCandidates(db as Prisma.TransactionClient, site, now), rewrittenRecently(db, site.id, now)]);
  return { pages: pages.filter(page => !taken.has(page.url)), taken: pages.length - pages.filter(page => !taken.has(page.url)).length };
}

type SchemaPage = { url: string; title: string | null; contentHash: string | null };
/** The latest crawl's indexable pages without structured data, and which of them are new since the previous crawl. */
export async function schemaPages(db: Db, site: Site, now: Date): Promise<{ crawl: { id: string; finishedAt: Date | null } | null; pages: SchemaPage[]; newCount: number }> {
  const crawls = await db.crawl.findMany({ where: { siteId: site.id, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, take: 2, select: { id: true, finishedAt: true } });
  const [latest, previous] = crawls;
  if (!latest) return { crawl: null, pages: [], newCount: 0 };
  const found: SchemaPage[] = await db.auditPage.findMany({ where: { crawlId: latest.id, hasSchema: false, statusCode: 200, indexable: true }, orderBy: { url: "asc" }, take: 500,
    select: { url: true, title: true, contentHash: true } });
  const pages = found.filter(page => { try { return !!siteUrl(page.url, site.domain); } catch { return false; } });
  const before = previous ? new Set<string>((await db.auditPage.findMany({ where: { crawlId: previous.id, url: { in: pages.map(page => page.url) } }, select: { url: true } })).map(page => page.url)) : null;
  const period = getGscDateRange(28, now);
  const metrics = pages.length ? await pageMetrics(db as Prisma.TransactionClient, site.id, new Date(`${period.start}T00:00:00.000Z`), new Date(`${period.end}T23:59:59.999Z`), pages.map(page => page.url)).catch(() => []) : [];
  const impressions = new Map<string, number>(metrics.map(row => [row.url, row.impressions]));
  return { crawl: latest, pages: schemaOrder(pages, impressions, before), newCount: before ? pages.filter(page => !before.has(page.url)).length : 0 };
}

/** Distinct search queries with impressions in the last 28 days (complete Search Console days only). */
export async function queryCount(db: Db, siteId: string, now: Date): Promise<number> {
  const period = getGscDateRange(28, now);
  const rows = await (db as Prisma.TransactionClient).$queryRaw<{ n: number }[]>`
    SELECT COUNT(DISTINCT d.query)::int AS n FROM "QueryPage" d
    JOIN "GscSyncCoverage" c ON c."siteId" = d."siteId" AND c.date = d.date
    JOIN "Site" s ON s.id = c."siteId" AND s."gscProperty" = c."gscProperty"
    WHERE d."siteId" = ${siteId} AND d.date BETWEEN ${new Date(`${period.start}T00:00:00.000Z`)} AND ${new Date(`${period.end}T23:59:59.999Z`)}
      AND c."queryPagesComplete" AND d.impressions > 0`;
  return Number(rows[0]?.n ?? 0);
}

export function alertWhere(siteId: string, scope: string | undefined) {
  return { siteId, enabled: true, ...(scope === "all" ? {} : { type: { in: [...DROP_ALERTS] } }) };
}

/** What each filler would find right now; null where it could not be counted. */
export type FillerPreview = {
  rankings: { runAt: string | null; keywords: number; competitors: number; queued: boolean } | null;
  alerts: { set: number; firedWeek: number } | null;
  meta: { pages: number; changed: number } | null;
  schema: { pages: number; newPages: number; open: number } | null;
  clusters: { queries: number; doneThisMonth: boolean } | null;
  briefs: { topics: number; open: number } | null;
};
const WEEK_MS = 7 * 24 * 60 * 60_000;
export const PREVIEW_TOPICS = 200;
/** Items still in the pool: waiting, or turned into a task that did not fail. Batch work queues the others again. */
export const LIVE_ITEM: Prisma.AiBacklogItemWhereInput = { OR: [{ status: "PENDING" }, { status: "STARTED", NOT: { job: { is: { status: "FAILED" } } } }] };

/**
 * Counts for each filler before it is turned on (or for the batch buttons):
 * the latest rank check's notable moves, the alerts in scope, the low-CTR
 * pages that could be rewritten, the pages without structured data, the
 * search queries and the planned topics without a brief. Nothing is queued.
 */
export async function poolPreview(db: PrismaClient, site: Site, automation: { alertsScope?: string; markers?: unknown } | null, now: Date): Promise<FillerPreview> {
  const markers = storedMarkers(automation?.markers);
  const counted = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try { return await work(); } catch (error) { console.error("[pool] preview failed:", error instanceof Error ? error.message : error); return null; }
  };
  const rankings = await counted(async () => {
    const run = await latestRankRun(db, site.id);
    if (!run) return { runAt: null, keywords: 0, competitors: 0, queued: false };
    const evidence = await collectActionEvidence(db as Prisma.TransactionClient, site, "rankings", now);
    const moves = rankMoves(evidence.sections.flatMap(section => section.rows as Record<string, unknown>[]));
    const queued = await db.aiBacklogItem.count({ where: { siteId: site.id, dedupeKey: `rankings:${run.id}`, ...LIVE_ITEM } });
    return { runAt: run.finishedAt?.toISOString() ?? null, ...moves, queued: queued > 0 };
  });
  const alerts = await counted(async () => {
    const where = alertWhere(site.id, automation?.alertsScope);
    return { set: await db.alert.count({ where }), firedWeek: await db.alert.count({ where: { ...where, lastFired: { gt: new Date(now.getTime() - WEEK_MS) } } }) };
  });
  const meta = await counted(async () => {
    const { pages } = await freshMetaCandidates(db, site, now);
    return { pages: pages.length, changed: metaChanges(pages, markers.metaSeen).changed.length };
  });
  const schema = await counted(async () => {
    const { crawl, pages, newCount } = await schemaPages(db, site, now);
    if (!crawl) return { pages: 0, newPages: 0, open: 0 };
    const keys = pages.map(page => schemaKey(page, crawl.id));
    const queued = keys.length ? await db.aiBacklogItem.count({ where: { siteId: site.id, dedupeKey: { in: keys }, ...LIVE_ITEM } }) : 0;
    return { pages: pages.length, newPages: newCount, open: pages.length - queued };
  });
  const clusters = await counted(async () => ({ queries: await queryCount(db, site.id, now), doneThisMonth: markers.clusterMonth === now.toISOString().slice(0, 7) }));
  const briefs = await counted(async () => {
    const topics = await db.contentCluster.findMany({ where: { siteId: site.id, status: "PLANNED", brief: { equals: Prisma.DbNull } }, take: PREVIEW_TOPICS, select: { id: true } });
    const queued = topics.length ? await db.aiBacklogItem.count({ where: { siteId: site.id, dedupeKey: { in: topics.map(topic => `brief:${topic.id}`) }, ...LIVE_ITEM } }) : 0;
    return { topics: topics.length, open: topics.length - queued };
  });
  return { rankings, alerts, meta, schema, clusters, briefs };
}

export type Plan = { items: NewItem[]; metaUrls: string[]; markers: Markers; status: FillerStatuses };

/**
 * What a site's fillers queue now, the markers that remember it and what each
 * filler found. force: check the daily ones (titles, clusters) even if they
 * looked today already (the owner's "check now"). A filler whose check fails
 * is noted as such and keeps its markers, so the others still run and it is
 * tried again next time.
 */
export async function plannedItems(db: Db, site: Site, automation: Automation, language: string, now: Date, force = false): Promise<Plan> {
  let markers = storedMarkers(automation.markers);
  const status = storedStatuses(automation.status);
  const items: NewItem[] = [];
  let metaUrls: string[] = [];
  const add = (item: Omit<NewItem, "priority">) => items.push({ ...item, priority: PRIORITY[item.source] });
  const checked = now.toISOString(), today = checked.slice(0, 10);
  const note = (filler: Filler, outcome: Outcome, count = 0, added = 0) => { status[filler] = { checkedAt: checked, outcome, count, added }; };
  const check = async (filler: Filler, work: () => Promise<void>) => {
    if (!automation[filler]) return;
    const before = { markers: { ...markers }, items: items.length, metaUrls };
    try { await work(); }
    catch (error) {
      console.error(`[pool] ${filler} check failed:`, error instanceof Error ? error.message : error);
      markers = before.markers; items.length = before.items; metaUrls = before.metaUrls;
      note(filler, "check_failed");
    }
  };

  await check("alerts", async () => {
    const since = markers.alertAt ? new Date(markers.alertAt) : now;
    const fired = await db.alert.findMany({ where: { ...alertWhere(site.id, automation.alertsScope), lastFired: { gt: since } }, orderBy: { lastFired: "desc" }, select: { lastFired: true } });
    if (fired[0]?.lastFired) {
      add({ source: "ALERTS", kind: "SEO_FIX_PLAN", title: itemTitle.alerts(language), payload: { scope: "alerts" }, dedupeKey: `alerts:${fired[0].lastFired.toISOString()}` });
      markers.alertAt = fired[0].lastFired.toISOString();
      note("alerts", "added", fired.length, 1);
    } else {
      // Without a marker the window would start anew at every check.
      markers.alertAt ??= since.toISOString();
      note("alerts", "none_fired");
    }
  });
  await check("rankings", async () => {
    const run = await latestRankRun(db, site.id);
    if (!run) return note("rankings", "no_run");
    if (run.id === markers.rankRunId) return note("rankings", "no_new_run");
    const evidence = await collectActionEvidence(db as Prisma.TransactionClient, site, "rankings", now);
    const moves = rankMoves(evidence.sections.flatMap(section => section.rows as Record<string, unknown>[]));
    if (moves.keywords || moves.competitors) {
      add({ source: "RANKINGS", kind: "SEO_FIX_PLAN", title: itemTitle.rankings(language), payload: { scope: "rankings" }, dedupeKey: `rankings:${run.id}` });
      note("rankings", "added", moves.keywords + moves.competitors, 1);
    } else note("rankings", "not_notable");
    markers.rankRunId = run.id;
  });
  if (force || markers.metaCheckedOn !== today) await check("meta", async () => {
    const { pages } = await freshMetaCandidates(db, site, now);
    const { changed, seen } = metaChanges(pages, markers.metaSeen);
    metaUrls = changed.slice(0, META_ITEM_MAX);
    markers.metaSeen = seen;
    markers.metaCheckedOn = today;
    note("meta", !pages.length ? "no_candidates" : metaUrls.length ? "added" : "no_change", pages.length, metaUrls.length);
  });
  await check("schema", async () => {
    const crawl = await db.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
    if (!crawl) return note("schema", "no_crawl");
    if (crawl.id === markers.crawlId) return note("schema", "no_new_crawl", status.schema?.count ?? 0);
    const waiting = await db.aiBacklogItem.count({ where: { siteId: site.id, source: "SCHEMA", status: "PENDING" } });
    const { pages } = await schemaPages(db, site, now);
    // A page whose content did not change since it was queued before is not queued again.
    const keyed = pages.map(page => ({ page, dedupeKey: schemaKey(page, crawl.id) }));
    const done = new Set((await db.aiBacklogItem.findMany({ where: { siteId: site.id, dedupeKey: { in: keyed.map(entry => entry.dedupeKey) } }, select: { dedupeKey: true } })).map(item => item.dedupeKey));
    const open = keyed.filter(entry => !done.has(entry.dedupeKey));
    const take = open.slice(0, Math.max(0, Math.min(SCHEMA_PER_CRAWL, PENDING_SCHEMA_MAX - waiting)));
    for (const { page, dedupeKey } of take) add({ source: "SCHEMA", kind: "SCHEMA_MARKUP", title: itemTitle.schema(language, page.title || page.url), payload: { url: page.url }, dedupeKey });
    note("schema", !pages.length ? "none_missing" : !open.length ? "no_change" : take.length ? "added" : "pool_full", pages.length, take.length);
    markers.crawlId = crawl.id;
  });
  await check("clusters", async () => {
    const month = checked.slice(0, 7);
    if (markers.clusterMonth === month) return note("clusters", "done_this_month");
    if (!force && markers.clusterCheckedOn === today) return;
    const queries = await queryCount(db, site.id, now);
    markers.clusterCheckedOn = today;
    if (queries < MIN_CLUSTER_QUERIES) return note("clusters", "not_enough_queries", queries);
    add({ source: "CLUSTERS", kind: "QUERY_CLUSTERS", title: itemTitle.clusters(language, month), payload: { limit: 200 }, dedupeKey: `clusters:${month}` });
    markers.clusterMonth = month;
    note("clusters", "added", queries, 1);
  });
  await check("briefs", async () => {
    const waiting = await db.aiBacklogItem.count({ where: { siteId: site.id, source: "BRIEF", status: "PENDING" } });
    const topics = await db.contentCluster.findMany({ where: { siteId: site.id, status: "PLANNED", brief: { equals: Prisma.DbNull } }, orderBy: { createdAt: "asc" }, take: 60, select: { id: true, title: true } });
    const queued = new Set((await db.aiBacklogItem.findMany({ where: { siteId: site.id, dedupeKey: { in: topics.map(topic => `brief:${topic.id}`) } }, select: { dedupeKey: true } })).map(item => item.dedupeKey));
    const open = topics.filter(topic => !queued.has(`brief:${topic.id}`));
    const take = open.slice(0, Math.max(0, PENDING_BRIEF_MAX - waiting));
    for (const topic of take) add({ source: "BRIEF", kind: "TOPIC_BRIEF", title: itemTitle.brief(language, topic.title), payload: { clusterId: topic.id }, dedupeKey: `brief:${topic.id}` });
    note("briefs", !topics.length ? "none_waiting" : !open.length ? "no_change" : take.length ? "added" : "pool_full", open.length || topics.length, take.length);
  });
  return { items, metaUrls, markers, status };
}

/**
 * Queues what a site's fillers found: replaces older waiting reviews,
 * diagnoses and clusterings, adds changed pages to the title rewrite already
 * waiting (or queues a new one), drops stale items, and saves what each filler
 * found. Returns the items added and the statuses saved.
 */
export async function fillSite(db: PrismaClient, site: Site, automation: Automation, language: string, now: Date, force = false): Promise<{ added: number; status: FillerStatuses }> {
  const plan = await plannedItems(db, site, automation, language, now, force);
  const added = await db.$transaction(async tx => {
    await tx.aiBacklogItem.updateMany({ where: { siteId: site.id, status: "PENDING", createdAt: { lt: new Date(now.getTime() - PENDING_MAX_AGE_MS) } }, data: { status: "SKIPPED", reason: "expired" } });
    for (const source of REPLACEABLE) {
      const keep = plan.items.filter(item => item.source === source).map(item => item.dedupeKey);
      if (keep.length) await tx.aiBacklogItem.updateMany({ where: { siteId: site.id, source, status: "PENDING", dedupeKey: { notIn: keep } }, data: { status: "SKIPPED", reason: "superseded" } });
    }
    // An item queued before (by a filler or by hand, under the same key) is not queued twice.
    const keys = plan.items.map(item => item.dedupeKey);
    const known = keys.length ? new Set((await tx.aiBacklogItem.findMany({ where: { siteId: site.id, dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map(item => item.dedupeKey)) : new Set<string>();
    const fresh = plan.items.filter(item => !known.has(item.dedupeKey));
    for (const filler of FILLERS) {
      const state = plan.status[filler];
      if (filler === "meta" || state?.outcome !== "added") continue;
      const count = fresh.filter(item => item.source === SOURCE_OF[filler]).length;
      plan.status[filler] = count ? { ...state, added: count } : { ...state, outcome: "already_queued", added: 0 };
    }
    let count = 0;
    if (plan.metaUrls.length) {
      const waiting = await tx.aiBacklogItem.findFirst({ where: { siteId: site.id, source: "META", status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true, payload: true } });
      const before = Array.isArray((waiting?.payload as { urls?: unknown } | null)?.urls) ? ((waiting!.payload as { urls: unknown[] }).urls.filter((url): url is string => typeof url === "string")) : [];
      const urls = [...new Set([...before, ...plan.metaUrls])].slice(0, META_ITEM_MAX);
      if (waiting) {
        await tx.aiBacklogItem.update({ where: { id: waiting.id }, data: { payload: { urls }, title: itemTitle.meta(language, urls.length) } });
        if (plan.status.meta) plan.status.meta = { ...plan.status.meta, outcome: "merged" };
      } else {
        await tx.aiBacklogItem.create({ data: { siteId: site.id, source: "META", kind: "META_REWRITE", title: itemTitle.meta(language, urls.length), payload: { urls },
          dedupeKey: `meta:${now.toISOString().slice(0, 10)}:${urlKey(urls.join("\n")).slice(0, 12)}`, priority: PRIORITY.META } });
        count++;
      }
    }
    const created = fresh.length ? await tx.aiBacklogItem.createMany({ data: fresh.map(item => ({ siteId: site.id, source: item.source, kind: item.kind, title: item.title,
      payload: item.payload as Prisma.InputJsonValue, dedupeKey: item.dedupeKey, priority: item.priority })), skipDuplicates: true }) : { count: 0 };
    plan.status = withLastAdded(storedStatuses(automation.status), plan.status);
    await tx.aiAutomation.update({ where: { siteId: site.id }, data: { markers: plan.markers as Prisma.InputJsonValue, status: plan.status as Prisma.InputJsonValue, filledAt: now } });
    return count + created.count;
  }, { timeout: 20000 });
  return { added, status: plan.status };
}

export const AUTOMATION_SELECT = { siteId: true, rankings: true, alerts: true, meta: true, schema: true, clusters: true, briefs: true, alertsScope: true, markers: true, status: true } as const;

/**
 * Fills up to `limit` sites whose pool was not filled in the last ten minutes,
 * of the worker's owner (every owner on a single-owner install) with the
 * pool turned on. A filler that fails is logged and tried again next time.
 */
export async function fillDueSites(db: PrismaClient, owner: { userId: string | null }, now: Date, limit = 2): Promise<number> {
  const rows = await db.aiAutomation.findMany({
    where: {
      AND: [
        { OR: [{ rankings: true }, { alerts: true }, { meta: true }, { schema: true }, { clusters: true }, { briefs: true }] },
        { OR: [{ filledAt: null }, { filledAt: { lt: new Date(now.getTime() - FILL_EVERY_MS) } }] },
      ],
      site: { ...(owner.userId ? { userId: owner.userId } : {}), user: { aiPoolSetting: { enabled: true } } },
    },
    orderBy: { filledAt: { sort: "asc", nulls: "first" } }, take: limit,
    select: { ...AUTOMATION_SELECT, site: { select: { id: true, domain: true, user: { select: { aiPoolSetting: { select: { language: true } } } } } } },
  });
  let added = 0;
  for (const row of rows) {
    try { added += (await fillSite(db, row.site, row, row.site.user.aiPoolSetting?.language ?? "zh-CN", now)).added; }
    catch (error) {
      console.error("[pool] fill failed:", error instanceof Error ? error.message : error);
      await db.aiAutomation.update({ where: { siteId: row.siteId }, data: { filledAt: now } }).catch(() => {});
    }
  }
  return added;
}
