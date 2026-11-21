import { z } from "zod";

/*
 * The local worker's reading of its Codex allowance, taken with Codex's own
 * app-server (account/rateLimits/read, which sends no message), and the rule
 * that decides whether background work may start (poolPolicy). Background
 * work never pushes either window past what the owner keeps in reserve, so
 * it never reaches the point where ChatGPT credits would be spent.
 */

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const MODEL_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export const limitWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().positive().max(525_600).nullable(),
  resetsAt: z.number().int().positive().nullable(),
}).strict();
export const workerLimitsSchema = z.object({
  planType: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable(),
  primary: limitWindowSchema.nullable(),
  secondary: limitWindowSchema.nullable(),
  reached: z.boolean(),
  hasCredits: z.boolean().nullable(),
}).strict();
export const workerModelSchema = z.object({
  id: z.string().regex(MODEL_ID),
  name: z.string().max(80),
  isDefault: z.boolean(),
  efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length),
  defaultEffort: z.enum(REASONING_EFFORTS).nullable(),
}).strict();
export const LIMIT_ERRORS = ["codex_unavailable", "login_required", "read_failed", "read_timeout", "unsupported"] as const;
export const WORKER_CAPABILITIES = ["routing-v1"] as const;

export type LimitWindow = z.infer<typeof limitWindowSchema>;
export type WorkerLimits = z.infer<typeof workerLimitsSchema>;
export type WorkerModel = z.infer<typeof workerModelSchema>;

/** A stored reading, or null when it is missing or malformed. */
export function storedLimits(value: unknown): WorkerLimits | null {
  return workerLimitsSchema.safeParse(value).data ?? null;
}
export function storedModels(value: unknown): WorkerModel[] {
  return z.array(workerModelSchema).max(40).safeParse(value).data ?? [];
}

const DAY_MINUTES = 24 * 60;

/**
 * The short (5-hour) and long (weekly) window of a reading. Codex reports the
 * short one as primary and the long one as secondary; the window lengths
 * decide when they are given. A Pro plan currently has no short window.
 */
export function windowsOf(limits: WorkerLimits): { short: LimitWindow | null; long: LimitWindow | null } {
  const windows = [limits.primary, limits.secondary].filter((item): item is LimitWindow => !!item);
  if (windows.every(item => item.windowMinutes !== null)) {
    return {
      short: windows.find(item => item.windowMinutes! <= DAY_MINUTES) ?? null,
      long: windows.find(item => item.windowMinutes! > DAY_MINUTES) ?? null,
    };
  }
  return { short: limits.primary, long: limits.secondary };
}

export type PoolReserves = { shortReserve: number; weeklyReserve: number };
export type PolicyReason = "no_reading" | "stale_reading" | "limit_reached" | "short_window" | "weekly_reserve" | "weekly_pace";
export type PolicyResult = { ok: true } | { ok: false; reason: PolicyReason; resumeAt: Date | null };

/** A reading older than this is not trusted to start background work. */
export const READING_MAX_AGE_MS = 15 * 60_000;
/** Percentage points the weekly use may run ahead of the time elapsed in the week. */
export const PACE_SLACK = 5;
const LAST_DAY_MS = 24 * 60 * 60_000;

/**
 * Whether background work may start now. The short window keeps
 * `shortReserve` percent for tasks the owner starts. The weekly window may be
 * used at the pace of the week (the share of the week gone by, plus a little),
 * and up to `100 - weeklyReserve` percent in the last day before it resets,
 * when what is left would otherwise expire unused.
 */
export function poolPolicy(limits: WorkerLimits | null, readAt: Date | null, now: Date, reserves: PoolReserves): PolicyResult {
  if (!limits || !readAt) return { ok: false, reason: "no_reading", resumeAt: null };
  if (now.getTime() - readAt.getTime() > READING_MAX_AGE_MS) return { ok: false, reason: "stale_reading", resumeAt: null };
  const { short, long } = windowsOf(limits);
  const resetOf = (window: LimitWindow | null) => window?.resetsAt ? new Date(window.resetsAt * 1000) : null;
  if (limits.reached) {
    const resets = [short, long].flatMap(window => window && window.usedPercent >= 100 ? [resetOf(window)] : []).filter((date): date is Date => !!date);
    return { ok: false, reason: "limit_reached", resumeAt: resets.length ? new Date(Math.max(...resets.map(date => date.getTime()))) : resetOf(short) ?? resetOf(long) };
  }
  if (!short && !long) return { ok: false, reason: "no_reading", resumeAt: null };
  if (short && short.usedPercent >= 100 - reserves.shortReserve) return { ok: false, reason: "short_window", resumeAt: resetOf(short) };
  if (long) {
    const ceiling = 100 - reserves.weeklyReserve;
    if (long.usedPercent >= ceiling) return { ok: false, reason: "weekly_reserve", resumeAt: resetOf(long) };
    if (long.resetsAt && long.windowMinutes) {
      const resetMs = long.resetsAt * 1000, windowMs = long.windowMinutes * 60_000;
      const remaining = resetMs - now.getTime();
      if (remaining > LAST_DAY_MS) {
        const elapsed = Math.min(1, Math.max(0, 1 - remaining / windowMs));
        if (long.usedPercent >= elapsed * 100 + PACE_SLACK) {
          // The pace line reaches today's use at this time, or the last day starts, whichever is first.
          const paceAt = resetMs - windowMs + ((long.usedPercent - PACE_SLACK) / 100) * windowMs;
          return { ok: false, reason: "weekly_pace", resumeAt: new Date(Math.min(paceAt, resetMs - LAST_DAY_MS)) };
        }
      }
    }
  }
  return { ok: true };
}
