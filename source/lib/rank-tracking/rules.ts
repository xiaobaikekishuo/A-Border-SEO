import { z } from "zod";
import { normalizeDomain } from "@/lib/geo/visibility-rules";
import { checkEstimateUsd, estimateRankRun } from "./costs";
import type { ResearchMarket } from "@/lib/dataforseo/market";
import type { Device, TopResult } from "./serp";

/*
 * The rules of rank tracking that need no database: settings, budget, how a
 * position moved, the summary and the drops an alert reports. Shared by the
 * server (tracking.ts, job.ts) and the screen.
 */

export const RANK_LIMITS = { tracked: 200, shown: 500, history: 60, keywordChars: 200 } as const;
export const RANK_DEPTHS = [10, 20, 30, 50, 100] as const;
/** Runs and their checks are kept this long. */
export const RANK_RETENTION_DAYS = 400;

export type RankSettings = { device: Device; depth: number; aiOverview: boolean; scheduleDays: number | null; budgetUsd: number };
export const DEFAULT_RANK_SETTINGS: RankSettings = { device: "desktop", depth: 30, aiOverview: false, scheduleDays: null, budgetUsd: 1 };

export type Movement = "UP" | "DOWN" | "SAME" | "ENTERED" | "LEFT";
export type CheckView = {
  position: number | null; absolute: number | null; url: string | null;
  aiOverview: boolean | null; aiCited: boolean | null; features: string[];
  checkedAt: string; runId: string;
};
export type RankRow = {
  /** The saved keyword's id. */
  id: string;
  keyword: string;
  tracked: boolean;
  notes: string | null;
  latest: CheckView | null;
  previous: CheckView | null;
  /** Places gained since the previous check (negative: lost); null unless both checks found the site. */
  change: number | null;
  movement: Movement | null;
  /** The page that ranks is not the one that ranked in the previous check. */
  urlChanged: boolean;
  /** The newest check failed after the latest one that worked. */
  failure: { error: string; at: string } | null;
  /** Search Console over the last 28 days, for comparison. */
  gsc: { position: number; clicks: number; impressions: number } | null;
  /** A search operator (site:, intitle: ...): never checked. */
  operator: boolean;
};
export type RankRunStatus = "POSTING" | "WAITING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export type RankRunRow = {
  id: string; source: string; status: RankRunStatus | "INTERRUPTED"; planned: number; checks: number; done: number; failed: number;
  costUsd: number; budgetUsd: number; device: string; depth: number; aiOverview: boolean;
  startedAt: string; postedAt: string | null; finishedAt: string | null; error: string | null; errorCode: string | null;
};
export type RankSummary = {
  tracked: number; checked: number; top3: number; top10: number; ranked: number; notRanked: number;
  up: number; down: number; aiOverview: number; aiCited: number;
};
export type RankEstimate = { tasks: number; usd: number; skipped: number };
export type RankWorkspace = {
  siteId: string;
  domain: string;
  settings: RankSettings;
  saved: boolean;
  rows: RankRow[];
  summary: RankSummary;
  runs: RankRunRow[];
  /** The check job queued or running, if any. */
  active: { jobId: string; status: "QUEUED" | "RUNNING" } | null;
  credentials: boolean;
  market: ResearchMarket;
  /** The next run with the saved settings: checks it posts, what they cost, tracked keywords the budget leaves out. */
  estimate: RankEstimate;
  /** A month of scheduled runs, or null when runs are started by hand. */
  monthlyUsd: number | null;
  /** False when this server runs no scheduled checks (SCHEDULER_ENABLED or SCHEDULE_RANK_TRACKING is false). */
  scheduler: boolean;
  limits: { tracked: number };
};

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

const settingsSchema = z.object({
  device: z.enum(["desktop", "mobile"]),
  depth: z.number().int().refine(d => (RANK_DEPTHS as readonly number[]).includes(d), "Choose 10, 20, 30, 50 or 100 results"),
  aiOverview: z.boolean(),
  scheduleDays: z.number().int().min(1).max(90).nullable(),
  budgetUsd: z.number().min(0.05).max(100),
}).strict();

export function parseRankSettings(body: unknown): RankSettings {
  const input = settingsSchema.parse(body);
  return { ...input, budgetUsd: Math.round(input.budgetUsd * 100) / 100 };
}

export type RankSettingsRecord = { device: string; depth: number; aiOverview: boolean; scheduleDays: number | null; budgetUsd: number };

/** Stored settings, read defensively; the defaults when the site has none. */
export function rankSettingsOf(record: RankSettingsRecord | null): RankSettings {
  if (!record) return { ...DEFAULT_RANK_SETTINGS };
  return {
    device: record.device === "mobile" ? "mobile" : "desktop",
    depth: (RANK_DEPTHS as readonly number[]).includes(record.depth) ? record.depth : DEFAULT_RANK_SETTINGS.depth,
    aiOverview: record.aiOverview === true,
    scheduleDays: Number.isInteger(record.scheduleDays) && (record.scheduleDays as number) >= 1 ? record.scheduleDays : null,
    budgetUsd: Number.isFinite(record.budgetUsd) && record.budgetUsd > 0 ? record.budgetUsd : DEFAULT_RANK_SETTINGS.budgetUsd,
  };
}

/** How many of `count` keywords one run checks within its budget. */
export function keywordsWithinBudget(count: number, settings: Pick<RankSettings, "depth" | "aiOverview" | "budgetUsd">): number {
  const each = checkEstimateUsd(settings.depth, settings.aiOverview);
  return Math.max(0, Math.min(count, Math.floor((settings.budgetUsd + 1e-9) / each)));
}

/** The next run: checks it posts, their expected cost, and how many tracked keywords the budget leaves out. */
export function runEstimate(tracked: number, settings: RankSettings): RankEstimate {
  const tasks = keywordsWithinBudget(tracked, settings);
  return { ...estimateRankRun(tasks, settings.depth, settings.aiOverview), skipped: tracked - tasks };
}

/* ------------------------------------------------------------------ */
/*  Pure reading                                                      */
/* ------------------------------------------------------------------ */

/** How a position moved between two checks of the same keyword. */
export function movementOf(previous: CheckView | null, latest: CheckView | null): { change: number | null; movement: Movement | null } {
  if (!previous || !latest) return { change: null, movement: null };
  const before = previous.position, now = latest.position;
  if (before === null && now === null) return { change: null, movement: null };
  if (before === null) return { change: null, movement: "ENTERED" };
  if (now === null) return { change: null, movement: "LEFT" };
  const change = before - now;
  return { change, movement: change > 0 ? "UP" : change < 0 ? "DOWN" : "SAME" };
}

export function rankSummary(rows: readonly RankRow[]): RankSummary {
  const tracked = rows.filter(r => r.tracked);
  const checked = tracked.filter(r => r.latest);
  const positions = checked.map(r => r.latest!.position);
  return {
    tracked: tracked.length,
    checked: checked.length,
    top3: positions.filter(p => p !== null && p <= 3).length,
    top10: positions.filter(p => p !== null && p <= 10).length,
    ranked: positions.filter(p => p !== null).length,
    notRanked: positions.filter(p => p === null).length,
    up: checked.filter(r => r.movement === "UP" || r.movement === "ENTERED").length,
    down: checked.filter(r => r.movement === "DOWN" || r.movement === "LEFT").length,
    aiOverview: checked.filter(r => r.latest!.aiOverview === true).length,
    aiCited: checked.filter(r => r.latest!.aiCited === true).length,
  };
}

export type RankDrop = { keyword: string; from: number; to: number | null };

/**
 * Keywords that fell `threshold` places or more, or off the first page,
 * between their previous check and the latest one. Only keywords that ranked
 * before can drop.
 */
export function rankDrops(rows: readonly { keyword: string; previous: number | null; latest: number | null; hadPrevious: boolean }[], threshold = 5): RankDrop[] {
  const out: RankDrop[] = [];
  for (const row of rows) {
    if (!row.hadPrevious || row.previous === null) continue;
    const fell = row.latest === null || row.latest - row.previous >= threshold;
    const leftFirstPage = row.previous <= 10 && (row.latest === null || row.latest > 10);
    if (fell || leftFirstPage) out.push({ keyword: row.keyword, from: row.previous, to: row.latest });
  }
  return out.sort((a, b) => (b.to ?? 1000) - b.from - ((a.to ?? 1000) - a.from));
}

/** The site's own domain, normalized, for matching results. */
export function ownDomainsOf(domain: string): string[] {
  const own = normalizeDomain(domain);
  return own ? [own] : [];
}

export function topOf(value: unknown): TopResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(v => {
    const o = v && typeof v === "object" ? v as Record<string, unknown> : null;
    if (!o || typeof o.url !== "string" || typeof o.domain !== "string" || !Number.isInteger(o.rank)) return [];
    return [{ rank: o.rank as number, domain: o.domain, url: o.url, title: typeof o.title === "string" ? o.title : null }];
  }).slice(0, 10);
}

/** The status a finished run gets: every check that was planned worked, some did, or none. */
export function finishedRunStatus(planned: number, ok: number, failed: number): "SUCCEEDED" | "PARTIAL" | "FAILED" {
  if (ok === 0) return "FAILED";
  return failed === 0 && ok >= planned ? "SUCCEEDED" : "PARTIAL";
}

/** How long the collector waits before its next pass: short at first, at most 15 minutes. */
export function nextCollectDelayMs(sincePostedMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.round(sincePostedMs / 4)));
}
