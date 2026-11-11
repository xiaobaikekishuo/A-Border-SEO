import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { siteMarket, type ResearchMarket } from "@/lib/dataforseo/market";
import { decrypt } from "@/lib/encryption";
import { scheduleConfig } from "@/lib/jobs/config";
import { TASK_ESTIMATE_USD, type DfsCredentials } from "./dataforseo-ai";
import { MAX_ANSWER_CHARS } from "./dataforseo-parse";
import { GEO_PLATFORM_IDS, TRACKED_PLATFORMS, isGeoPlatformId, type GeoPlatformId } from "./platforms";
import {
  analyzeAnswer, markdownLinks, normalizeCitations, normalizeDomain, summarizeVisibility,
  type AnswerAnalysis, type AnswerRow, type Citation, type PlatformVisibility, type TrackingBrands,
} from "./visibility-rules";

/*
 * Prompt tracking: the prompts a site wants to be found for, the brands to
 * look for, and the answers collected from each platform (by a run through
 * DataForSEO, or recorded by hand). Analysis happens on read with the current
 * brand settings, so a corrected alias applies to every answer; each run also
 * keeps the summary it had when it finished, for the trend.
 */

export const TRACKING_LIMITS = { activePrompts: 50, prompts: 300, promptChars: 500, competitors: 10, aliases: 10, domains: 5 } as const;
/** How far back the latest answer of a prompt on a platform still counts as current. */
export const LATEST_WINDOW_DAYS = 90;
const RUN_HISTORY = 12;

export type TrackingSettings = { brands: TrackingBrands; platforms: GeoPlatformId[]; scheduleDays: number | null; budgetUsd: number };
export type PromptRow = { id: string; text: string; tag: string | null; active: boolean; createdAt: string };
export type RunStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export type RunSummary = Partial<Record<GeoPlatformId, Pick<PlatformVisibility, "answers" | "noAnswer" | "failed" | "mentionRate" | "citationRate" | "shareOfVoice" | "avgCitationRank" | "avgMentionRank">>>;
export type RunRow = {
  id: string; source: string; status: RunStatus | "INTERRUPTED"; planned: number; done: number; failed: number;
  costUsd: number; budgetUsd: number; startedAt: string; finishedAt: string | null; error: string | null; errorCode: string | null;
  summary: RunSummary | null;
  /** A trial: the first active prompt on each platform, to check the setup and the cost. */
  trial: boolean;
};
export type AnswerMeta = { model?: string | null; consulted?: number; fanOut?: string[]; organicRank?: number | null };
export type LatestCell = {
  answerId: string; promptId: string; platform: GeoPlatformId; source: "DATAFORSEO" | "MANUAL"; status: AnswerRow["status"];
  createdAt: string; ownMentioned: boolean; ownCited: boolean; ownRank: number | null; mentionRank: number | null;
  competitors: string[]; citations: number; error: string | null;
};
export type TrackingWorkspace = {
  siteId: string;
  domain: string;
  settings: TrackingSettings | null;
  prompts: PromptRow[];
  runs: RunRow[];
  active: ActiveRun | null;
  latest: { since: string; platforms: Partial<Record<GeoPlatformId, PlatformVisibility>>; cells: LatestCell[] };
  credentials: boolean;
  market: ResearchMarket;
  estimate: { tasks: number; usd: number };
  /** A trial run: the first active prompt on each chosen platform. */
  trialEstimate: { tasks: number; usd: number };
  /** False when this server runs no scheduled tracking (SCHEDULER_ENABLED or SCHEDULE_GEO_TRACKING is false). */
  scheduler: boolean;
};

type Db = PrismaClient;

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

const name = z.string().trim().min(1).max(80);
const entity = z.object({
  name,
  aliases: z.array(name).max(TRACKING_LIMITS.aliases).default([]),
  domains: z.array(z.string().trim().min(1).max(253)).max(TRACKING_LIMITS.domains).default([]),
}).strict();
const settingsSchema = z.object({
  brands: z.object({ own: entity, competitors: z.array(entity).max(TRACKING_LIMITS.competitors) }).strict(),
  platforms: z.array(z.string()).max(GEO_PLATFORM_IDS.length),
  scheduleDays: z.number().int().min(1).max(90).nullable(),
  budgetUsd: z.number().min(0.05).max(100),
}).strict();
const promptText = z.string().trim().min(3).max(TRACKING_LIMITS.promptChars);
const tag = z.string().trim().max(40).nullable().optional();
const addPromptsSchema = z.object({ prompts: z.array(z.object({ text: promptText, tag }).strict()).min(1).max(100) }).strict();
const updatePromptSchema = z.object({ id: z.string().min(1).max(40), active: z.boolean().optional(), tag }).strict();
const manualAnswerSchema = z.object({
  promptId: z.string().min(1).max(40),
  platform: z.string(),
  status: z.enum(["OK", "NO_ANSWER"]),
  text: z.string().max(MAX_ANSWER_CHARS),
  citations: z.array(z.string().trim().max(2048)).max(60),
}).strict();

function domains(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const domain = normalizeDomain(value);
    if (!domain) throw new ContentError(`Not a domain: ${value.slice(0, 80)}`, 422);
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

/** Settings as entered, checked: known platforms, real domains, the site's own domain always among its brand's. */
export function parseSettings(body: unknown, siteDomain: string): TrackingSettings {
  const input = settingsSchema.parse(body);
  const unknown = input.platforms.filter(p => !isGeoPlatformId(p) || !TRACKED_PLATFORMS.includes(p));
  if (unknown.length) throw new ContentError(`Not trackable through DataForSEO: ${unknown.join(", ").slice(0, 120)}`, 422);
  const ownDomain = normalizeDomain(siteDomain);
  const own = { ...input.brands.own, domains: domains([...(ownDomain ? [ownDomain] : []), ...input.brands.own.domains]) };
  const competitors = input.brands.competitors.map(c => ({ ...c, domains: domains(c.domains) }));
  const names = [own.name, ...competitors.map(c => c.name)].map(n => n.toLowerCase());
  if (new Set(names).size !== names.length) throw new ContentError("Each brand needs its own name", 422);
  return {
    brands: { own, competitors },
    platforms: [...new Set(input.platforms)] as GeoPlatformId[],
    scheduleDays: input.scheduleDays,
    budgetUsd: Math.round(input.budgetUsd * 100) / 100,
  };
}

/** Brand settings as stored, read defensively. */
export function storedBrands(value: unknown, siteDomain: string): TrackingBrands {
  const parsed = z.object({ own: entity, competitors: z.array(entity) }).safeParse(value);
  if (parsed.success) return parsed.data;
  return { own: { name: siteDomain, aliases: [], domains: [siteDomain] }, competitors: [] };
}

/** What a run of `prompts` active prompts on `platforms` is expected to cost. */
export function estimateRun(prompts: number, platforms: readonly GeoPlatformId[]): { tasks: number; usd: number } {
  const perPrompt = platforms.reduce((sum, p) => sum + (TASK_ESTIMATE_USD[p] ?? 0), 0);
  return { tasks: prompts * platforms.length, usd: Math.round(prompts * perPrompt * 10000) / 10000 };
}

/* ------------------------------------------------------------------ */
/*  Reading                                                           */
/* ------------------------------------------------------------------ */

export async function ownedTrackingSite(db: Db, userId: string | undefined, siteId: string) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, userId: true, domain: true, researchLanguage: true, researchLocation: true },
  });
  if (!site) throw new ContentError("Unknown site", 404);
  return site as { id: string; userId: string; domain: string; researchLanguage: string; researchLocation: number };
}

/** The user's DataForSEO login, or null when none is saved. */
export async function dataForSeoCredentials(db: Db, userId: string): Promise<DfsCredentials | null> {
  const key = await db.apiKey.findUnique({
    where: { userId_provider: { userId, provider: "dataforseo" } },
    select: { encryptedLogin: true, encryptedPassword: true },
  }) as { encryptedLogin: string | null; encryptedPassword: string } | null;
  if (!key?.encryptedLogin) return null;
  return { login: decrypt(key.encryptedLogin), password: decrypt(key.encryptedPassword) };
}

type TrackingRecord = { brands: unknown; platforms: string[] | null; scheduleDays: number | null; budgetUsd: number };

export function settingsOf(record: TrackingRecord | null, siteDomain: string): TrackingSettings | null {
  if (!record) return null;
  return {
    brands: storedBrands(record.brands, siteDomain),
    platforms: (record.platforms ?? []).filter((p): p is GeoPlatformId => isGeoPlatformId(p) && TRACKED_PLATFORMS.includes(p)),
    scheduleDays: record.scheduleDays,
    budgetUsd: record.budgetUsd,
  };
}

type AnswerRecord = {
  id: string; promptId: string; platform: string; source: string; status: string; text: string | null;
  citations: unknown; error: string | null; createdAt: Date;
};

function citationsOf(value: unknown): Citation[] {
  return Array.isArray(value)
    ? normalizeCitations(value.filter((c): c is { url: string; title?: string | null } => !!c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string"))
    : [];
}

/** An answer read with the current brands. */
export function analyzeRecord(record: AnswerRecord, brands: TrackingBrands): { row: AnswerRow; analysis: AnswerAnalysis; citations: Citation[] } {
  const citations = citationsOf(record.citations);
  const status = record.status === "OK" || record.status === "NO_ANSWER" ? record.status : "FAILED";
  const analysis = status === "OK"
    ? analyzeAnswer(record.text ?? "", citations, brands)
    : { ownMentioned: false, ownCited: false, ownRank: null, mentionRank: null, mentions: [], competitorsCited: [] };
  return {
    row: { platform: record.platform, status, ownMentioned: analysis.ownMentioned, ownCited: analysis.ownCited, ownRank: analysis.ownRank, mentionRank: analysis.mentionRank, mentions: analysis.mentions, citations },
    analysis,
    citations,
  };
}

/** Per-platform summaries of a set of answers. */
export function summarizeByPlatform(records: readonly AnswerRecord[], brands: TrackingBrands): Partial<Record<GeoPlatformId, PlatformVisibility>> {
  const rows = new Map<GeoPlatformId, AnswerRow[]>();
  for (const record of records) {
    if (!isGeoPlatformId(record.platform)) continue;
    const list = rows.get(record.platform) ?? [];
    list.push(analyzeRecord(record, brands).row);
    rows.set(record.platform, list);
  }
  const out: Partial<Record<GeoPlatformId, PlatformVisibility>> = {};
  for (const [platform, list] of rows) out[platform] = summarizeVisibility(list, brands);
  return out;
}

export function compactSummary(summary: Partial<Record<GeoPlatformId, PlatformVisibility>>): RunSummary {
  const out: RunSummary = {};
  for (const [platform, v] of Object.entries(summary) as [GeoPlatformId, PlatformVisibility][]) {
    out[platform] = { answers: v.answers, noAnswer: v.noAnswer, failed: v.failed, mentionRate: v.mentionRate, citationRate: v.citationRate, shareOfVoice: v.shareOfVoice, avgCitationRank: v.avgCitationRank, avgMentionRank: v.avgMentionRank };
  }
  return out;
}

const answerSelect = { id: true, promptId: true, platform: true, source: true, status: true, text: true, citations: true, error: true, createdAt: true } as const;

/**
 * The newest answer per active prompt and platform within the window. A
 * failed attempt does not hide an earlier answer: it shows only where the
 * window holds no answer at all.
 */
export async function latestAnswers(db: Db, siteId: string, now = new Date()): Promise<{ since: Date; records: AnswerRecord[] }> {
  const since = new Date(now.getTime() - LATEST_WINDOW_DAYS * 86_400_000);
  // Ids first: Prisma applies `distinct` after reading the rows, so the texts are read only for the winners.
  const newest = (failed: boolean) => db.geoAnswer.findMany({
    where: { siteId, createdAt: { gte: since }, prompt: { active: true }, status: failed ? "FAILED" : { in: ["OK", "NO_ANSWER"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    distinct: ["promptId", "platform"],
    select: { id: true, promptId: true, platform: true },
  }) as Promise<{ id: string; promptId: string; platform: string }[]>;
  const [answered, failed] = await Promise.all([newest(false), newest(true)]);
  const seen = new Set(answered.map(r => `${r.promptId}\0${r.platform}`));
  const ids = [...answered, ...failed.filter(r => !seen.has(`${r.promptId}\0${r.platform}`))].map(r => r.id);
  if (!ids.length) return { since, records: [] };
  const records = await db.geoAnswer.findMany({ where: { id: { in: ids } }, select: answerSelect }) as AnswerRecord[];
  return { since, records };
}

function runRow(run: {
  id: string; source: string; status: string; planned: number; done: number; failed: number; costUsd: number; budgetUsd: number;
  startedAt: Date; finishedAt: Date | null; error: string | null; errorCode: string | null; summary: unknown; jobId: string | null; plan: unknown;
}, activeJobId: string | null): RunRow {
  const interrupted = run.status === "RUNNING" && run.jobId !== activeJobId;
  return {
    id: run.id, source: run.source, status: interrupted ? "INTERRUPTED" : (run.status as RunStatus), planned: run.planned, done: run.done,
    failed: run.failed, costUsd: run.costUsd, budgetUsd: run.budgetUsd, startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null, error: run.error, errorCode: run.errorCode,
    summary: (run.summary as RunSummary | null) ?? null,
    trial: isTrialPlan(run.plan),
  };
}

/** The job type of a tracking run (registered in lib/jobs/handlers.ts). */
export const GEO_VISIBILITY_JOB = "geo-visibility";
/**
 * The job type of a trial run: the first active prompt on each platform. Its
 * own type, so the scheduler never counts a trial as the site's latest run
 * and old-job cleanup keeps the latest full run either way.
 */
export const GEO_TRIAL_JOB = "geo-visibility-trial";
export const GEO_JOB_TYPES = [GEO_VISIBILITY_JOB, GEO_TRIAL_JOB] as const;

export const isTrialPlan = (plan: unknown) => !!plan && typeof plan === "object" && (plan as { trial?: unknown }).trial === true;

export type ActiveRun = { jobId: string; status: "QUEUED" | "RUNNING"; trial: boolean };

/** The tracking job queued or running for the site, a full run or a trial: one at a time. */
export async function activeTrackingJob(db: Db, siteId: string): Promise<ActiveRun | null> {
  const job = await db.job.findFirst({
    where: { siteId, type: { in: [...GEO_JOB_TYPES] }, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, type: true },
  }) as { id: string; status: "QUEUED" | "RUNNING"; type: string } | null;
  return job ? { jobId: job.id, status: job.status, trial: job.type === GEO_TRIAL_JOB } : null;
}

export async function readTrackingWorkspace(db: Db, userId: string | undefined, siteId: string, now = new Date()): Promise<TrackingWorkspace> {
  const site = await ownedTrackingSite(db, userId, siteId);
  const [record, prompts, runs, job, key, latest] = await Promise.all([
    db.geoTracking.findUnique({ where: { siteId }, select: { brands: true, platforms: true, scheduleDays: true, budgetUsd: true } }) as Promise<TrackingRecord | null>,
    db.geoPrompt.findMany({ where: { siteId }, orderBy: [{ active: "desc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, text: true, tag: true, active: true, createdAt: true } }) as Promise<{ id: string; text: string; tag: string | null; active: boolean; createdAt: Date }[]>,
    db.geoRun.findMany({ where: { siteId }, orderBy: { startedAt: "desc" }, take: RUN_HISTORY }),
    activeTrackingJob(db, siteId),
    db.apiKey.count({ where: { userId: site.userId, provider: "dataforseo", encryptedLogin: { not: null } } }) as Promise<number>,
    latestAnswers(db, siteId, now),
  ]);
  const settings = settingsOf(record, site.domain);
  const brands = settings?.brands ?? storedBrands(null, site.domain);
  const cells: LatestCell[] = [];
  for (const r of latest.records) {
    if (!isGeoPlatformId(r.platform)) continue;
    const { analysis, citations } = analyzeRecord(r, brands);
    cells.push({
      answerId: r.id, promptId: r.promptId, platform: r.platform, source: r.source === "MANUAL" ? "MANUAL" : "DATAFORSEO",
      status: r.status === "OK" || r.status === "NO_ANSWER" ? r.status : "FAILED", createdAt: r.createdAt.toISOString(),
      ownMentioned: analysis.ownMentioned, ownCited: analysis.ownCited, ownRank: analysis.ownRank, mentionRank: analysis.mentionRank,
      competitors: analysis.mentions.filter(m => !m.own).map(m => m.name), citations: citations.length, error: r.error,
    });
  }
  const activePrompts = prompts.filter(p => p.active).length;
  return {
    siteId: site.id,
    domain: site.domain,
    settings,
    prompts: prompts.map(p => ({ id: p.id, text: p.text, tag: p.tag, active: p.active, createdAt: p.createdAt.toISOString() })),
    runs: (runs as Parameters<typeof runRow>[0][]).map(run => runRow(run, job?.jobId ?? null)),
    active: job,
    latest: { since: latest.since.toISOString(), platforms: summarizeByPlatform(latest.records, brands), cells },
    credentials: key > 0,
    market: siteMarket(site),
    estimate: estimateRun(activePrompts, settings?.platforms ?? []),
    trialEstimate: estimateRun(Math.min(1, activePrompts), settings?.platforms ?? []),
    scheduler: schedulerRunsTracking(),
  };
}

function schedulerRunsTracking(): boolean {
  const config = scheduleConfig();
  return config.enabled && config.geoTracking;
}

/** What the page polls while a run is going: the active job and the latest run, without the answers. */
export async function readTrackingProgress(db: Db, userId: string | undefined, siteId: string): Promise<Pick<TrackingWorkspace, "active" | "runs">> {
  await ownedTrackingSite(db, userId, siteId);
  const [job, run] = await Promise.all([
    activeTrackingJob(db, siteId),
    db.geoRun.findFirst({ where: { siteId }, orderBy: { startedAt: "desc" } }),
  ]);
  return {
    active: job,
    runs: run ? [runRow(run as Parameters<typeof runRow>[0], job?.jobId ?? null)] : [],
  };
}

/** One answer in full, with how it reads for the current brands, and the earlier answers to the same prompt there. */
export async function readAnswer(db: Db, userId: string | undefined, siteId: string, answerId: string) {
  const site = await ownedTrackingSite(db, userId, siteId);
  const answer = await db.geoAnswer.findFirst({
    where: { id: answerId, siteId },
    select: { ...answerSelect, meta: true, costUsd: true, runId: true, prompt: { select: { text: true } } },
  }) as (AnswerRecord & { meta: unknown; costUsd: number; runId: string | null; prompt: { text: string } }) | null;
  if (!answer) throw new ContentError("Unknown answer", 404);
  const record = await db.geoTracking.findUnique({ where: { siteId }, select: { brands: true, platforms: true, scheduleDays: true, budgetUsd: true } }) as TrackingRecord | null;
  const brands = settingsOf(record, site.domain)?.brands ?? storedBrands(null, site.domain);
  const history = await db.geoAnswer.findMany({
    where: { siteId, promptId: answer.promptId, platform: answer.platform },
    orderBy: { createdAt: "desc" }, take: 10, select: answerSelect,
  }) as AnswerRecord[];
  const { analysis, citations } = analyzeRecord(answer, brands);
  const owns = (domain: string, list: readonly string[]) => list.some(d => domain === d || domain.endsWith("." + d));
  return {
    id: answer.id, prompt: answer.prompt.text, platform: answer.platform, source: answer.source, status: answer.status,
    text: answer.text, error: answer.error, createdAt: answer.createdAt.toISOString(), costUsd: answer.costUsd,
    meta: (answer.meta ?? {}) as AnswerMeta, analysis,
    citations: citations.map(c => ({
      ...c,
      owner: owns(c.domain, brands.own.domains) ? brands.own.name : brands.competitors.find(b => owns(c.domain, b.domains))?.name ?? null,
    })),
    history: history.map(h => {
      const read = analyzeRecord(h, brands);
      return { id: h.id, createdAt: h.createdAt.toISOString(), source: h.source, status: read.row.status, ownMentioned: read.analysis.ownMentioned, ownCited: read.analysis.ownCited };
    }),
  };
}

/* ------------------------------------------------------------------ */
/*  Writing                                                           */
/* ------------------------------------------------------------------ */

export async function saveTrackingSettings(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<TrackingSettings> {
  const site = await ownedTrackingSite(db, userId, siteId);
  const settings = parseSettings(body, site.domain);
  await db.geoTracking.upsert({
    where: { siteId },
    create: { siteId, brands: settings.brands, platforms: settings.platforms, scheduleDays: settings.scheduleDays, budgetUsd: settings.budgetUsd },
    update: { brands: settings.brands, platforms: settings.platforms, scheduleDays: settings.scheduleDays, budgetUsd: settings.budgetUsd },
  });
  return settings;
}

/** Adds prompts; ones the site already has are skipped. */
export async function addPrompts(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<{ added: number; skipped: number }> {
  await ownedTrackingSite(db, userId, siteId);
  const { prompts } = addPromptsSchema.parse(body);
  const unique = [...new Map(prompts.map(p => [p.text.replace(/\s+/g, " "), p])).entries()].map(([text, p]) => ({ text, tag: p.tag || null }));
  const [total, active] = await Promise.all([
    db.geoPrompt.count({ where: { siteId } }) as Promise<number>,
    db.geoPrompt.count({ where: { siteId, active: true } }) as Promise<number>,
  ]);
  if (total + unique.length > TRACKING_LIMITS.prompts) throw new ContentError(`A site can keep up to ${TRACKING_LIMITS.prompts} prompts`, 422);
  const room = Math.max(0, TRACKING_LIMITS.activePrompts - active);
  const created = await db.geoPrompt.createMany({
    data: unique.map((p, i) => ({ siteId, text: p.text, tag: p.tag, active: i < room })),
    skipDuplicates: true,
  }) as { count: number };
  return { added: created.count, skipped: unique.length - created.count };
}

export async function updatePrompt(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<void> {
  await ownedTrackingSite(db, userId, siteId);
  const input = updatePromptSchema.parse(body);
  if (input.active) {
    const active = await db.geoPrompt.count({ where: { siteId, active: true, id: { not: input.id } } }) as number;
    if (active >= TRACKING_LIMITS.activePrompts) throw new ContentError(`Up to ${TRACKING_LIMITS.activePrompts} prompts can be active`, 422);
  }
  const updated = await db.geoPrompt.updateMany({
    where: { id: input.id, siteId },
    data: { ...(input.active !== undefined && { active: input.active }), ...(input.tag !== undefined && { tag: input.tag || null }) },
  }) as { count: number };
  if (!updated.count) throw new ContentError("Unknown prompt", 404);
}

/** Deletes a prompt and every answer collected for it. */
export async function deletePrompt(db: Db, userId: string | undefined, siteId: string, promptId: string): Promise<void> {
  await ownedTrackingSite(db, userId, siteId);
  const deleted = await db.geoPrompt.deleteMany({ where: { id: promptId, siteId } }) as { count: number };
  if (!deleted.count) throw new ContentError("Unknown prompt", 404);
}

/** An answer seen in the platform's own app, for platforms DataForSEO cannot ask (or as a spot check of one it can). */
export async function recordManualAnswer(db: Db, userId: string | undefined, siteId: string, body: unknown): Promise<{ id: string }> {
  await ownedTrackingSite(db, userId, siteId);
  const input = manualAnswerSchema.parse(body);
  if (!isGeoPlatformId(input.platform)) throw new ContentError("Unknown platform", 422);
  const prompt = await db.geoPrompt.findFirst({ where: { id: input.promptId, siteId }, select: { id: true } });
  if (!prompt) throw new ContentError("Unknown prompt", 404);
  const text = input.status === "OK" ? input.text.trim() : "";
  if (input.status === "OK" && !text) throw new ContentError("Paste the answer text", 422);
  const listed = input.citations.filter(Boolean).map(url => ({ url }));
  const citations = normalizeCitations(listed.length ? listed : markdownLinks(text));
  const created = await db.geoAnswer.create({
    data: { siteId, promptId: input.promptId, platform: input.platform, source: "MANUAL", status: input.status, text: text || null, citations },
    select: { id: true },
  }) as { id: string };
  return created;
}

/** Deletes one answer; answers of a run are part of its record, so only recorded ones. */
export async function deleteManualAnswer(db: Db, userId: string | undefined, siteId: string, answerId: string): Promise<void> {
  await ownedTrackingSite(db, userId, siteId);
  const deleted = await db.geoAnswer.deleteMany({ where: { id: answerId, siteId, source: "MANUAL" } }) as { count: number };
  if (!deleted.count) throw new ContentError("Unknown answer", 404);
}

/** What a run would do now: the checks against starting one, and its size. A trial asks only the first active prompt. */
export async function runPlan(db: Db, userId: string | undefined, siteId: string, opts: { trial?: boolean } = {}) {
  const site = await ownedTrackingSite(db, userId, siteId);
  const record = await db.geoTracking.findUnique({ where: { siteId }, select: { brands: true, platforms: true, scheduleDays: true, budgetUsd: true } }) as TrackingRecord | null;
  const settings = settingsOf(record, site.domain);
  if (!settings) throw new ContentError("Save the tracking settings first", 422);
  if (!settings.platforms.length) throw new ContentError("Choose at least one platform to ask", 422);
  const prompts = await db.geoPrompt.count({ where: { siteId, active: true } }) as number;
  if (!prompts) throw new ContentError("Add at least one active prompt", 422);
  if (!(await dataForSeoCredentials(db, site.userId))) throw new ContentError("Add your DataForSEO login in Settings first", 422);
  return { site, settings, market: siteMarket(site), trial: opts.trial === true, ...estimateRun(opts.trial ? 1 : prompts, settings.platforms) };
}

