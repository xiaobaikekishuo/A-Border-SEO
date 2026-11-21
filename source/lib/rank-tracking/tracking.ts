import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { siteMarket } from "@/lib/dataforseo/market";
import { dataForSeoCredentials, ownedTrackingSite } from "@/lib/geo/tracking";
import { scheduleConfig } from "@/lib/jobs/config";
import { getTopKeywords } from "@/lib/seo-metrics";
import { monthlyEstimateUsd } from "./costs";
import {
  movementOf, parseRankSettings, rankSettingsOf, rankSummary, rankDrops, runEstimate, topOf, RANK_LIMITS,
  type CheckView, type RankDrop, type RankRow, type RankRunRow, type RankRunStatus, type RankSettings, type RankSettingsRecord, type RankWorkspace,
} from "./rules";
import { hasSearchOperator, type TopResult } from "./serp";

export * from "./rules";

/*
 * Rank tracking: the measured Google position of the saved keywords marked
 * for tracking, in the site's research market, checked through DataForSEO
 * (lib/rank-tracking/job.ts runs the checks). Search Console's average
 * position blends every searcher, country and device; a check reads one
 * results page as a searcher in that market sees it, so the two answer
 * different questions and the screen shows both.
 */

/** The job that posts a run, and the job that collects its results (registered in lib/jobs/handlers.ts). */
export const RANK_CHECK_JOB = "rank-check";
export const RANK_COLLECT_JOB = "rank-collect";

type Db = PrismaClient;
const RUN_HISTORY = 12;

/* ------------------------------------------------------------------ */
/*  Reading                                                           */
/* ------------------------------------------------------------------ */

type CheckRecord = {
  keyword: string; status: string; position: number | null; absolute: number | null; url: string | null;
  aiOverview: boolean | null; aiCited: boolean | null; features: string[] | null; error: string | null;
  checkedAt: Date | null; createdAt: Date; runId: string; n: number | bigint;
};

function viewOf(record: CheckRecord): CheckView {
  return {
    position: record.position, absolute: record.absolute, url: record.url,
    aiOverview: record.aiOverview, aiCited: record.aiCited, features: record.features ?? [],
    checkedAt: (record.checkedAt ?? record.createdAt).toISOString(), runId: record.runId,
  };
}

/** The two newest checks that worked and the newest failure of every keyword of the site. */
async function latestChecks(db: Db, siteId: string): Promise<Map<string, { ok: CheckRecord[]; failed: CheckRecord | null }>> {
  const rows = await db.$queryRaw<CheckRecord[]>`
    SELECT x.keyword, x.status, x.position, x.absolute, x.url, x."aiOverview", x."aiCited", x.features, x.error, x."checkedAt", x."createdAt", x."runId", x.n
    FROM (
      SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.keyword, c.status ORDER BY c."createdAt" DESC, c.id DESC) AS n
      FROM "RankCheck" c
      WHERE c."siteId" = ${siteId} AND c.status IN ('OK', 'FAILED')
    ) x
    WHERE (x.status = 'OK' AND x.n <= 2) OR (x.status = 'FAILED' AND x.n = 1)`;
  const out = new Map<string, { ok: CheckRecord[]; failed: CheckRecord | null }>();
  for (const row of rows) {
    const entry = out.get(row.keyword) ?? { ok: [], failed: null };
    if (row.status === "OK") entry.ok.push(row);
    else entry.failed = row;
    out.set(row.keyword, entry);
  }
  for (const entry of out.values()) entry.ok.sort((a, b) => Number(a.n) - Number(b.n));
  return out;
}

type RunRecord = {
  id: string; source: string; status: string; planned: number; done: number; failed: number; costUsd: number; budgetUsd: number;
  device: string; depth: number; aiOverview: boolean; startedAt: Date; postedAt: Date | null; finishedAt: Date | null;
  error: string | null; errorCode: string | null; jobId: string | null; _count?: { checks: number };
};

export function rankRunRow(run: RunRecord, activeJobId: string | null): RankRunRow {
  // Posting, but its job is gone: the process stopped and nothing resumes it.
  const interrupted = run.status === "POSTING" && run.jobId !== activeJobId;
  return {
    id: run.id, source: run.source, status: interrupted ? "INTERRUPTED" : run.status as RankRunStatus, planned: run.planned,
    checks: run._count?.checks ?? run.planned, done: run.done, failed: run.failed, costUsd: run.costUsd, budgetUsd: run.budgetUsd,
    device: run.device, depth: run.depth, aiOverview: run.aiOverview, startedAt: run.startedAt.toISOString(),
    postedAt: run.postedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error, errorCode: run.errorCode,
  };
}

export async function activeRankJob(db: Db, siteId: string): Promise<RankWorkspace["active"]> {
  const job = await db.job.findFirst({
    where: { siteId, type: RANK_CHECK_JOB, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  }) as { id: string; status: "QUEUED" | "RUNNING" } | null;
  return job ? { jobId: job.id, status: job.status } : null;
}

const settingsSelect = { device: true, depth: true, aiOverview: true, scheduleDays: true, budgetUsd: true } as const;
const runSelect = {
  id: true, source: true, status: true, planned: true, done: true, failed: true, costUsd: true, budgetUsd: true, device: true, depth: true,
  aiOverview: true, startedAt: true, postedAt: true, finishedAt: true, error: true, errorCode: true, jobId: true, _count: { select: { checks: true } },
} as const;

export async function readRankWorkspace(db: Db, userId: string | undefined, siteId: string): Promise<RankWorkspace> {
  const site = await ownedTrackingSite(db, userId, siteId);
  const [record, saved, runs, active, key, checks] = await Promise.all([
    db.rankTracking.findUnique({ where: { siteId }, select: settingsSelect }) as Promise<RankSettingsRecord | null>,
    db.savedKeyword.findMany({
      where: { siteId }, orderBy: [{ tracked: "desc" }, { createdAt: "asc" }, { id: "asc" }], take: RANK_LIMITS.shown,
      select: { id: true, query: true, notes: true, tracked: true },
    }) as Promise<{ id: string; query: string; notes: string | null; tracked: boolean }[]>,
    db.rankRun.findMany({ where: { siteId }, orderBy: { startedAt: "desc" }, take: RUN_HISTORY, select: runSelect }) as Promise<RunRecord[]>,
    activeRankJob(db, siteId),
    db.apiKey.count({ where: { userId: site.userId, provider: "dataforseo", encryptedLogin: { not: null } } }) as Promise<number>,
    latestChecks(db, siteId),
  ]);
  const gsc = saved.length ? await getTopKeywords(siteId, 28, saved.length, saved.map(s => s.query)) : [];
  const gscBy = new Map(gsc.map(row => [row.query, row]));
  const rows: RankRow[] = saved.map(s => {
    const entry = checks.get(s.query);
    const latest = entry?.ok[0] ? viewOf(entry.ok[0]) : null;
    const previous = entry?.ok[1] ? viewOf(entry.ok[1]) : null;
    const failedAt = entry?.failed?.createdAt;
    const failure = entry?.failed && (!entry.ok[0] || failedAt! > entry.ok[0].createdAt)
      ? { error: entry.failed.error ?? "The check failed", at: failedAt!.toISOString() } : null;
    const g = gscBy.get(s.query);
    return {
      id: s.id, keyword: s.query, tracked: s.tracked, notes: s.notes, latest, previous, ...movementOf(previous, latest),
      urlChanged: !!latest?.url && !!previous?.url && latest.url !== previous.url,
      failure, gsc: g ? { position: g.position, clicks: g.clicks, impressions: g.impressions } : null,
      operator: hasSearchOperator(s.query),
    };
  });
  const settings = rankSettingsOf(record);
  const trackedCount = rows.filter(r => r.tracked && !r.operator).length;
  const estimate = runEstimate(trackedCount, settings);
  return {
    siteId: site.id,
    domain: site.domain,
    settings,
    saved: !!record,
    rows,
    summary: rankSummary(rows),
    runs: runs.map(run => rankRunRow(run, active?.jobId ?? null)),
    active,
    credentials: key > 0,
    market: siteMarket(site),
    estimate,
    monthlyUsd: monthlyEstimateUsd(estimate.tasks, settings.depth, settings.aiOverview, settings.scheduleDays),
    scheduler: schedulerRunsRankTracking(),
    limits: { tracked: RANK_LIMITS.tracked },
  };
}

export function schedulerRunsRankTracking(): boolean {
  const config = scheduleConfig();
  return config.enabled && config.rankTracking;
}

/** What the page polls while a run is going: the check job and the runs not finished yet. */
export async function readRankProgress(db: Db, userId: string | undefined, siteId: string): Promise<Pick<RankWorkspace, "active" | "runs">> {
  await ownedTrackingSite(db, userId, siteId);
  const [active, runs] = await Promise.all([
    activeRankJob(db, siteId),
    db.rankRun.findMany({ where: { siteId }, orderBy: { startedAt: "desc" }, take: RUN_HISTORY, select: runSelect }) as Promise<RunRecord[]>,
  ]);
  return { active, runs: runs.map(run => rankRunRow(run, active?.jobId ?? null)) };
}

export type KeywordHistory = {
  keyword: string;
  checks: { at: string; status: "OK" | "FAILED"; position: number | null; url: string | null; aiOverview: boolean | null; aiCited: boolean | null; error: string | null }[];
  /** The first ten organic results of the newest check that worked. */
  top: TopResult[];
  topAt: string | null;
};

/** One keyword's checks, oldest first, and who held the first ten places in the newest one. */
export async function keywordHistory(db: Db, userId: string | undefined, siteId: string, keyword: string): Promise<KeywordHistory> {
  await ownedTrackingSite(db, userId, siteId);
  const text = keyword.trim();
  if (!text || text.length > RANK_LIMITS.keywordChars) throw new ContentError("Unknown keyword", 404);
  const checks = await db.rankCheck.findMany({
    where: { siteId, keyword: text, status: { in: ["OK", "FAILED"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RANK_LIMITS.history,
    select: { status: true, position: true, url: true, aiOverview: true, aiCited: true, error: true, checkedAt: true, createdAt: true, top: true },
  }) as { status: string; position: number | null; url: string | null; aiOverview: boolean | null; aiCited: boolean | null; error: string | null; checkedAt: Date | null; createdAt: Date; top: unknown }[];
  const newestOk = checks.find(c => c.status === "OK");
  return {
    keyword: text,
    checks: checks.reverse().map(c => ({
      at: (c.checkedAt ?? c.createdAt).toISOString(), status: c.status === "OK" ? "OK" : "FAILED", position: c.position, url: c.url,
      aiOverview: c.aiOverview, aiCited: c.aiCited, error: c.error,
    })),
    top: topOf(newestOk?.top),
    topAt: newestOk ? (newestOk.checkedAt ?? newestOk.createdAt).toISOString() : null,
  };
}

/**
 * The drops in the newest finished run that ended after `since`: keywords
 * that fell `threshold` places or off the first page since their previous
 * check. Null when no such run exists, so an alert fires once per run.
 */
export async function latestRankDrops(db: Db, siteId: string, threshold: number, since: Date | null): Promise<{ runId: string; drops: RankDrop[] } | null> {
  const run = await db.rankRun.findFirst({
    where: { siteId, status: { in: ["SUCCEEDED", "PARTIAL"] }, finishedAt: { not: null, ...(since && { gt: since }) } },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  }) as { id: string } | null;
  if (!run) return null;
  const rows = await db.$queryRaw<{ keyword: string; position: number | null; previous: number | null; hadPrevious: boolean }[]>`
    SELECT c.keyword, c.position, p.position AS "previous", (p.id IS NOT NULL) AS "hadPrevious"
    FROM "RankCheck" c
    LEFT JOIN LATERAL (
      SELECT q.id, q.position FROM "RankCheck" q
      WHERE q."siteId" = c."siteId" AND q.keyword = c.keyword AND q.status = 'OK' AND q."runId" <> c."runId" AND q."createdAt" < c."createdAt"
      ORDER BY q."createdAt" DESC, q.id DESC
      LIMIT 1
    ) p ON true
    WHERE c."runId" = ${run.id} AND c.status = 'OK'`;
  return { runId: run.id, drops: rankDrops(rows.map(r => ({ keyword: r.keyword, previous: r.previous, latest: r.position, hadPrevious: r.hadPrevious })), threshold) };
}

/* ------------------------------------------------------------------ */
/*  Writing                                                           */
/* ------------------------------------------------------------------ */

export async function saveRankSettings(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<RankSettings> {
  await ownedTrackingSite(db, userId, siteId);
  const settings = parseRankSettings(body);
  await db.rankTracking.upsert({ where: { siteId }, create: { siteId, ...settings }, update: settings });
  return settings;
}

const addSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(RANK_LIMITS.keywordChars)).min(1).max(RANK_LIMITS.tracked),
}).strict();
const trackSchema = z.object({ ids: z.array(z.string().min(1).max(40)).min(1).max(RANK_LIMITS.shown), tracked: z.boolean() }).strict();

const cleanKeyword = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Saves keywords and marks them for tracking. Keywords already saved are
 * marked too. Search operators are saved but never tracked, and past the
 * limit of tracked keywords the rest are saved without tracking.
 */
export async function addTrackedKeywords(db: Db, userId: string | undefined, siteId: string, body: unknown) {
  await ownedTrackingSite(db, userId, siteId);
  const input = addSchema.parse(body);
  const keywords = [...new Set(input.keywords.map(cleanKeyword).filter(Boolean))];
  const operators = keywords.filter(hasSearchOperator);
  const wanted = keywords.filter(k => !hasSearchOperator(k));
  const existing = await db.savedKeyword.findMany({ where: { siteId, query: { in: keywords } }, select: { query: true, tracked: true } }) as { query: string; tracked: boolean }[];
  const saved = new Map(existing.map(e => [e.query, e.tracked]));
  const tracked = await db.savedKeyword.count({ where: { siteId, tracked: true } }) as number;
  const toTrack = wanted.filter(k => saved.get(k) !== true);
  const allowed = toTrack.slice(0, Math.max(0, RANK_LIMITS.tracked - tracked));
  const allowedSet = new Set(allowed);
  const created = await db.savedKeyword.createMany({
    data: keywords.filter(k => !saved.has(k)).map(query => ({ siteId, query, tracked: allowedSet.has(query) })),
    skipDuplicates: true,
  }) as { count: number };
  const marked = allowed.filter(k => saved.has(k));
  if (marked.length) await db.savedKeyword.updateMany({ where: { siteId, query: { in: marked } }, data: { tracked: true } });
  return { saved: created.count, tracked: allowed.length, operators: operators.length, overLimit: toTrack.length - allowed.length };
}

/** Turns tracking on or off for saved keywords, up to the limit. */
export async function setTracked(db: Db, userId: string | undefined, siteId: string, body: unknown) {
  await ownedTrackingSite(db, userId, siteId);
  const input = trackSchema.parse(body);
  if (!input.tracked) {
    const off = await db.savedKeyword.updateMany({ where: { siteId, id: { in: input.ids } }, data: { tracked: false } }) as { count: number };
    return { updated: off.count, operators: 0, overLimit: 0 };
  }
  const rows = await db.savedKeyword.findMany({ where: { siteId, id: { in: input.ids }, tracked: false }, select: { id: true, query: true } }) as { id: string; query: string }[];
  const usable = rows.filter(r => !hasSearchOperator(r.query));
  const tracked = await db.savedKeyword.count({ where: { siteId, tracked: true } }) as number;
  const allowed = usable.slice(0, Math.max(0, RANK_LIMITS.tracked - tracked));
  const on = allowed.length
    ? await db.savedKeyword.updateMany({ where: { siteId, id: { in: allowed.map(a => a.id) } }, data: { tracked: true } }) as { count: number }
    : { count: 0 };
  return { updated: on.count, operators: rows.length - usable.length, overLimit: usable.length - allowed.length };
}

/** What a run would do now: the checks against starting one, and its size. */
export async function rankRunPlan(db: Db, userId: string | undefined, siteId: string) {
  const site = await ownedTrackingSite(db, userId, siteId);
  const record = await db.rankTracking.findUnique({ where: { siteId }, select: settingsSelect }) as RankSettingsRecord | null;
  const settings = rankSettingsOf(record);
  const keywords = await db.savedKeyword.findMany({ where: { siteId, tracked: true }, select: { query: true }, take: RANK_LIMITS.tracked }) as { query: string }[];
  const tracked = keywords.filter(k => !hasSearchOperator(k.query)).length;
  if (!tracked) throw new ContentError("Mark at least one saved keyword for tracking", 422);
  if (!(await dataForSeoCredentials(db, site.userId))) throw new ContentError("Add your DataForSEO login in Settings first", 422);
  return { site, settings, market: siteMarket(site), ...runEstimate(tracked, settings) };
}
