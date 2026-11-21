import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { gscComparisonWindows } from "@/lib/gsc-coverage";
import { calculatePercentChange, getGscDateRange } from "@/lib/date-utils";

export type PeriodMetrics = {
  clicks: number;
  impressions: number;
  avgPosition: number;
  avgCtr: number;
  uniqueKeywords: number;
};

export type KeywordRow = {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  ctr: number;
};

export type PageRow = {
  url: string;
  clicks: number;
  impressions: number;
  position: number;
  ctr: number;
};

export type DailyTraffic = {
  date: string;
  clicks: number;
  impressions: number;
};

/** A period: the last N days, or the days from startDate to endDate (YYYY-MM-DD, both included). */
export type Period = number | { startDate: string; endDate: string };

function parseRange(period: Period) {
  const { start, end } =
    typeof period === "number" ? getGscDateRange(period) : { start: period.startDate, end: period.endDate };
  return {
    start: new Date(`${start}T00:00:00.000Z`),
    end: new Date(`${end}T23:59:59.999Z`),
  };
}

/** Impression-weighted average position */
function weightedPosition(
  rows: { position: number; impressions: number }[]
): number {
  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    const w = Math.max(row.impressions, 0);
    weighted += row.position * w;
    weight += w;
  }
  if (weight === 0) {
    if (rows.length === 0) return 0;
    return rows.reduce((s, r) => s + r.position, 0) / rows.length;
  }
  return weighted / weight;
}

function aggregatePeriod(
  rows: { clicks: number; impressions: number; position: number }[],
  uniqueKeywords = 0
): PeriodMetrics {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  return {
    clicks,
    impressions,
    avgPosition: weightedPosition(rows),
    avgCtr: impressions > 0 ? clicks / impressions : 0,
    uniqueKeywords,
  };
}

export type ReportDay = { date: string; clicks: number; impressions: number; position: number };

/** Select one basis for the whole period, from the currently bound property only. */
async function loadSearchSeries(tx: Prisma.TransactionClient, siteId: string, period: Period) {
  const { start, end } = parseRange(period);
  const site = await tx.site.findUnique({ where: { id: siteId }, select: { gscProperty: true } });
  const coverage = site?.gscProperty ? await tx.gscSyncCoverage.findMany({
    where: { siteId, gscProperty: site.gscProperty, date: { gte: start, lte: end } },
    select: { date: true, pagesComplete: true, queryPagesComplete: true, syncedAt: true,
      propertyChecked: true, propertyClicks: true, propertyImpressions: true, propertyPosition: true },
    orderBy: { date: "asc" },
  }) : [];
  const basis = coverage.some(day => day.propertyChecked) ? "property" as const : "page" as const;
  const label = (date: Date) => date.toISOString().slice(0, 10);
  let rows: ReportDay[];
  if (basis === "property") {
    rows = coverage.flatMap(day => day.propertyChecked && day.propertyClicks !== null &&
      day.propertyImpressions !== null && day.propertyPosition !== null ? [{ date: label(day.date),
      clicks: day.propertyClicks, impressions: day.propertyImpressions, position: day.propertyPosition }] : []);
  } else {
    const dates = coverage.filter(day => day.pagesComplete).map(day => day.date);
    // Summed per day in Postgres: one row per day leaves the database, not one per page and day.
    const days = dates.length ? await tx.$queryRaw<{ date: Date; clicks: number; impressions: number; weighted: number }[]>`
      SELECT date, SUM(clicks)::float8 AS clicks, SUM(impressions)::float8 AS impressions,
        SUM(position * impressions)::float8 AS weighted
      FROM "Page" WHERE "siteId" = ${siteId} AND date IN (${Prisma.join(dates.map(d => Prisma.sql`${d.toISOString()}::timestamp`))})
      GROUP BY date ORDER BY date` : [];
    rows = days.map(day => ({ date: label(new Date(day.date)), clicks: Number(day.clicks), impressions: Number(day.impressions),
      position: Number(day.impressions) > 0 ? Number(day.weighted) / Number(day.impressions) : 0 }));
  }
  return { basis, rows, coverage };
}

export async function getSitePeriodMetrics(siteId: string, days = 28) {
  const windows = gscComparisonWindows(days);
  return db.$transaction(async tx => {
    const series = await loadSearchSeries(tx, siteId, { startDate: windows.previous.start, endDate: windows.current.end });
    const currentRows = series.rows.filter(day => day.date >= windows.current.start);
    const previousRows = series.rows.filter(day => day.date < windows.current.start);
    const currentStart = new Date(windows.current.start);
    const currentDates = series.coverage.filter(day => day.date >= currentStart);
    const previousDates = series.coverage.filter(day => day.date < currentStart);
    // Counted in Postgres: the distinct queries themselves never leave the database.
    const keywordCount = async (dates: typeof currentDates) => {
      const known = dates.filter(day => day.queryPagesComplete).map(day => day.date);
      if (!known.length) return 0;
      const [row] = await tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT query)::int AS count FROM "Keyword" WHERE "siteId" = ${siteId} AND date IN (${Prisma.join(known.map(d => Prisma.sql`${d.toISOString()}::timestamp`))})`;
      return Number(row?.count ?? 0);
    };
    const current = aggregatePeriod(currentRows, await keywordCount(currentDates));
    const previous = aggregatePeriod(previousRows, await keywordCount(previousDates));
    const comparable = currentRows.length === days && previousRows.length === days;
    const coverage = { ...windows, expectedDays: days,
      currentDays: currentDates.filter(d => d.pagesComplete).length, previousDays: previousDates.filter(d => d.pagesComplete).length,
      currentReportedDays: currentRows.length, previousReportedDays: previousRows.length,
      currentComplete: currentRows.length === days, previousComplete: previousRows.length === days, comparable,
      queryPagesComplete: currentDates.filter(d => d.queryPagesComplete).length === days,
      lastSyncedAt: series.coverage.length ? new Date(Math.max(...series.coverage.map(row => row.syncedAt.getTime()))).toISOString() : null };
    return { current, previous, basis: series.basis, coverage, deltas: {
      clicks: comparable ? calculatePercentChange(current.clicks, previous.clicks) : null,
      impressions: comparable ? calculatePercentChange(current.impressions, previous.impressions) : null,
      avgPosition: comparable && current.impressions > 0 && previous.impressions > 0 ? previous.avgPosition - current.avgPosition : null,
      avgCtr: comparable && current.impressions > 0 && previous.impressions > 0 ? calculatePercentChange(current.avgCtr, previous.avgCtr) : null,
    } };
  }, { isolationLevel: "RepeatableRead" });
}

/**
 * Scope each raw row through the successful sync for that day and the site's
 * current property in one snapshot. Older rows without provenance stay stored
 * until a sync verifies their date. Only the requested groups leave Postgres.
 */
function groupedGscDetails(siteId: string, period: Period, dimension: "query" | "url", queries?: string[]) {
  const { start, end } = parseRange(period);
  const keywords = dimension === "query";
  const table = keywords ? Prisma.sql`"Keyword"` : Prisma.sql`"Page"`;
  const key = keywords ? Prisma.sql`d."query"` : Prisma.sql`d."url"`;
  const complete = keywords ? Prisma.sql`c."queryPagesComplete"` : Prisma.sql`c."pagesComplete"`;
  const filter = queries?.length ? Prisma.sql`AND d."query" IN (${Prisma.join(queries)})` : Prisma.empty;
  return Prisma.sql`
    SELECT ${key} AS label, SUM(d.clicks)::float8 AS clicks, SUM(d.impressions)::float8 AS impressions,
      COALESCE(SUM(d.position * d.impressions) / NULLIF(SUM(d.impressions), 0), AVG(d.position)) AS position,
      COALESCE(SUM(d.clicks)::float8 / NULLIF(SUM(d.impressions), 0), 0) AS ctr
    FROM ${table} d
    JOIN "GscSyncCoverage" c ON c."siteId" = d."siteId" AND c.date = d.date
    JOIN "Site" s ON s.id = c."siteId" AND s."gscProperty" = c."gscProperty"
    WHERE d."siteId" = ${siteId} AND d.date BETWEEN ${start} AND ${end} AND ${complete} ${filter}
    GROUP BY ${key}`;
}

type RankedDetail = Omit<KeywordRow, "query"> & { label: string };
function rankedGscDetails(siteId: string, period: Period, limit: number, dimension: "query" | "url", queries?: string[]) {
  return db.$queryRaw<RankedDetail[]>`${groupedGscDetails(siteId, period, dimension, queries)}
    ORDER BY clicks DESC, impressions DESC, label ASC LIMIT ${limit}`;
}

// The same expected-CTR curve ranks low-CTR candidates and estimates their potential in the UI.
const ctrCurve = [[1, 0.28], [2, 0.15], [3, 0.11], [5, 0.07], [10, 0.03], [20, 0.01]] as const;
const longTailCtr = 0.005;
export function expectedCtr(position: number): number {
  return ctrCurve.find(([lastPosition]) => position <= lastPosition)?.[1] ?? longTailCtr;
}

// Materialize the period once, then take each list by its own score. A query
// with no clicks can lead either opportunity list even on a large site.
export async function getOverviewKeywordCandidates(siteId: string, limit: number): Promise<KeywordRow[]> {
  const curve = Prisma.join(ctrCurve.map(([last, rate]) => Prisma.sql`WHEN position <= ${last} THEN ${rate}::float8`), " ");
  const rows = await db.$queryRaw<RankedDetail[]>`
    WITH ranked AS MATERIALIZED (${groupedGscDetails(siteId, 28, "query")}),
    gaps AS (SELECT *, CASE ${curve} ELSE ${longTailCtr}::float8 END - ctr AS gap FROM ranked),
    candidates AS (
      (SELECT label FROM ranked ORDER BY clicks DESC, impressions DESC, label LIMIT 10)
      UNION
      (SELECT label FROM ranked WHERE position BETWEEN 4 AND 20 AND impressions >= 20
       ORDER BY impressions DESC, clicks DESC, label LIMIT ${limit})
      UNION
      (SELECT label FROM gaps WHERE impressions >= 50 AND position <= 15 AND gap > 0.02
       ORDER BY impressions * gap DESC, clicks DESC, impressions DESC, label LIMIT ${limit})
    )
    SELECT ranked.* FROM ranked JOIN candidates USING (label) ORDER BY clicks DESC, impressions DESC, label`;
  return rows.map(({ label, ...metrics }) => ({ query: label, ...metrics }));
}

export async function getTopKeywords(siteId: string, period: Period = 28, limit = 50, queries?: string[]): Promise<KeywordRow[]> {
  if (queries?.length === 0) return [];
  const rows = await rankedGscDetails(siteId, period, limit, "query", queries);
  return rows.map(({ label, ...metrics }) => ({ query: label, ...metrics }));
}

export async function getTopPages(siteId: string, period: Period = 28, limit = 50): Promise<PageRow[]> {
  const rows = await rankedGscDetails(siteId, period, limit, "url");
  return rows.map(({ label, ...metrics }) => ({ url: label, ...metrics }));
}

export async function getDailyTrafficSeries(siteId: string, period: Period = 90) {
  return db.$transaction(async tx => {
    const { basis, rows } = await loadSearchSeries(tx, siteId, period);
    return { basis, days: rows.map(({ date, clicks, impressions }) => ({ date, clicks, impressions })) };
  }, { isolationLevel: "RepeatableRead" });
}

/** Daily totals with the average position, on the same basis as the period metrics: the overview's sparklines. */
export async function getDailySearchRows(siteId: string, period: Period = 28): Promise<ReportDay[]> {
  return db.$transaction(async tx => (await loadSearchSeries(tx, siteId, period)).rows, { isolationLevel: "RepeatableRead" });
}

export async function getDailyTraffic(siteId: string, period: Period = 90): Promise<DailyTraffic[]> {
  return (await getDailyTrafficSeries(siteId, period)).days;
}

export function formatPosition(position: number): string {
  if (!Number.isFinite(position) || position <= 0) return "n/a";
  return position.toFixed(1);
}

export function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`;
}

export function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function positionBand(position: number): "top3" | "top10" | "top20" | "deep" {
  if (position > 0 && position <= 3) return "top3";
  if (position <= 10) return "top10";
  if (position <= 20) return "top20";
  return "deep";
}
