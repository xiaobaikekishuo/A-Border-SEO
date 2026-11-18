import { db } from "@/lib/db";

export type BingReportDays = 28 | 90 | 180;
export type BingDailyPoint = {
  date: string;
  clicks: number | null;
  impressions: number | null;
  crawledPages: number | null;
  inIndex: number | null;
  crawlErrors: number | null;
  blockedByRobots: number | null;
  code4xx: number | null;
  code5xx: number | null;
};
export type BingSearchSummary = {
  key: string;
  clicks: number | null;
  impressions: number | null;
  /** Fraction, not a percentage. Unknown and zero impressions have no CTR. */
  ctr: number | null;
  position: number | null;
  weeks: number;
};
export type BingReport = {
  days: BingReportDays;
  startDate: string;
  endDate: string;
  daily: BingDailyPoint[];
  totals: {
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
    indexedPages: number | null;
    crawledPages: number | null;
    crawlErrors: number | null;
    blockedByRobots: number | null;
  };
  keywords: BingSearchSummary[];
  pages: BingSearchSummary[];
  /** Actual reported days / distinct week buckets, before the 500-row table cap. */
  coverage: { dailyDays: number; queryWeeks: number; pageWeeks: number };
  latestDataDate: string | null;
  latestSync: {
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    finishedAt: string | null;
    partial: string[];
    errorCode: string | null;
  } | null;
  hasData: boolean;
};

const DAY = 86_400_000;
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const metrics = ["clicks", "impressions", "crawledPages", "inIndex", "crawlErrors", "blockedByRobots", "code4xx", "code5xx"] as const;
const count = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
const ctr = (clicks: number | null, impressions: number | null) =>
  clicks !== null && impressions !== null && impressions > 0 ? clicks / impressions : null;

/** A missing metric in a reported row makes its total unknown, not a partial sum. */
function total(values: Array<number | null>): number | null {
  if (!values.length || values.some(value => count(value) === null)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

type WeeklyRow = { kind: string; key: string; weekEnding: Date; clicks: number | null; impressions: number | null; avgImpressionPosition: number | null };
function searchSummary(rows: WeeklyRow[]): BingSearchSummary[] {
  const groups = new Map<string, WeeklyRow[]>();
  for (const row of rows) {
    const group = groups.get(row.key) ?? [];
    group.push(row);
    groups.set(row.key, group);
  }
  return Array.from(groups, ([key, group]) => {
    const clicks = total(group.map(row => row.clicks));
    const impressions = total(group.map(row => row.impressions));
    let weighted = 0, weight = 0;
    for (const row of group) {
      const position = row.avgImpressionPosition;
      const impressions = count(row.impressions);
      if (position !== null && Number.isFinite(position) && position > 0 && impressions !== null && impressions > 0) {
        weighted += position * impressions;
        weight += impressions;
      }
    }
    return { key, clicks, impressions, ctr: ctr(clicks, impressions),
      position: weight > 0 ? weighted / weight : null,
      weeks: new Set(group.map(row => dayKey(row.weekEnding))).size };
  }).sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1)
    || (b.impressions ?? -1) - (a.impressions ?? -1) || a.key.localeCompare(b.key)).slice(0, 500);
}

const partialEndpoints = new Set(["traffic", "queries", "pages", "crawl"]);
const syncErrors = new Set(["NOT_CONNECTED", "KEY_MISSING", "REAUTH_REQUIRED", "QUOTA_EXCEEDED", "MANAGED_RESTRICTED"]);
function partialResult(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("partial" in result) || !Array.isArray(result.partial)) return [];
  return [...new Set(result.partial.filter((value): value is string => typeof value === "string" && partialEndpoints.has(value)))];
}

/** Caller must authorize the local user and site before reading this report. No sync is triggered here. */
export async function getBingReport(siteId: string, days: BingReportDays, now = new Date()): Promise<BingReport> {
  if (![28, 90, 180].includes(days) || !Number.isFinite(now.getTime())) throw new RangeError("Invalid Bing report period");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - days * DAY);
  const range = { gte: start, lt: today };
  // One repeatable snapshot keeps a property replacement or disconnect from
  // mixing older daily data with newer weekly data and sync metadata.
  const [dailyRows, weeklyRows, latestDay, latestWeek, latestJob] = await db.$transaction([
    db.bingDaily.findMany({ where: { siteId, date: range }, orderBy: { date: "asc" },
      select: { date: true, clicks: true, impressions: true, crawledPages: true, inIndex: true,
        crawlErrors: true, blockedByRobots: true, code4xx: true, code5xx: true } }),
    db.bingSearchWeekly.findMany({ where: { siteId, kind: { in: ["query", "page"] }, weekEnding: range },
      select: { kind: true, key: true, weekEnding: true, clicks: true, impressions: true, avgImpressionPosition: true } }),
    db.bingDaily.aggregate({ where: { siteId }, _max: { date: true } }),
    db.bingSearchWeekly.aggregate({ where: { siteId, kind: { in: ["query", "page"] } }, _max: { weekEnding: true } }),
    db.job.findFirst({ where: { siteId, type: "bing-sync" }, orderBy: { createdAt: "desc" },
      select: { status: true, finishedAt: true, result: true, errorCode: true } }),
  ], { isolationLevel: "RepeatableRead" });

  const reported: BingDailyPoint[] = dailyRows.map(row => ({ date: dayKey(row.date), ...Object.fromEntries(
    metrics.map(key => [key, count(row[key])])) })) as BingDailyPoint[];
  const byDay = new Map(reported.map(row => [row.date, row]));
  const daily = Array.from({ length: days }, (_, index): BingDailyPoint => {
    const date = dayKey(new Date(start.getTime() + index * DAY));
    return byDay.get(date) ?? { date, clicks: null, impressions: null, crawledPages: null, inIndex: null,
      crawlErrors: null, blockedByRobots: null, code4xx: null, code5xx: null };
  });
  const clicks = total(reported.map(row => row.clicks));
  const impressions = total(reported.map(row => row.impressions));
  const queryRows = weeklyRows.filter(row => row.kind === "query");
  const pageRows = weeklyRows.filter(row => row.kind === "page");
  const latestDates = [latestDay._max.date, latestWeek._max.weekEnding].filter((date): date is Date => date !== null);

  return {
    days, startDate: dayKey(start), endDate: dayKey(new Date(today.getTime() - DAY)), daily,
    totals: { clicks, impressions, ctr: ctr(clicks, impressions),
      indexedPages: reported.findLast(row => row.inIndex !== null)?.inIndex ?? null,
      crawledPages: total(reported.map(row => row.crawledPages)),
      crawlErrors: total(reported.map(row => row.crawlErrors)),
      blockedByRobots: total(reported.map(row => row.blockedByRobots)) },
    keywords: searchSummary(queryRows), pages: searchSummary(pageRows),
    coverage: { dailyDays: reported.length, queryWeeks: new Set(queryRows.map(row => dayKey(row.weekEnding))).size,
      pageWeeks: new Set(pageRows.map(row => dayKey(row.weekEnding))).size },
    latestDataDate: latestDates.length ? dayKey(new Date(Math.max(...latestDates.map(date => date.getTime())))) : null,
    latestSync: latestJob ? { status: latestJob.status, finishedAt: latestJob.finishedAt?.toISOString() ?? null,
      partial: partialResult(latestJob.result), errorCode: latestJob.errorCode && syncErrors.has(latestJob.errorCode) ? latestJob.errorCode : null } : null,
    hasData: reported.length > 0 || weeklyRows.length > 0,
  };
}
