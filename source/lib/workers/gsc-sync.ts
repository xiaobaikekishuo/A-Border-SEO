import { db } from "@/lib/db";
import { fetchSearchAnalytics, fetchPageAnalytics, gscDate } from "@/lib/google";
import { getGscDateRange } from "@/lib/date-utils";

import { aggregateByQueryAndDate } from "@/lib/google/aggregate";

interface SyncResult {
  success: boolean;
  keywordsInserted: number;
  pagesInserted: number;
  uniqueKeywords?: number;
  uniquePages?: number;
  queryPagesInserted?: number;
  startDate: string;
  endDate: string;
  error?: string;
}

/**
 * Syncs GSC data for a specific site
 * Fetches two complete 28-day periods of keywords and pages data
 */
export async function syncGSCDataForSite(
  userId: string,
  siteId: string,
  daysBack: number = 28
): Promise<SyncResult> {
  try {
    // Verify site belongs to user
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, gscProperty: true },
    });

    if (!site) {
      throw new Error("Site not found");
    }

    if (site.userId !== userId) {
      throw new Error("Unauthorized: Site does not belong to user");
    }

    if (!site.gscProperty) {
      throw new Error("Site does not have GSC property connected");
    }

    return await runGSCSync(userId, siteId, site.gscProperty, daysBack);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[GSC Sync] Error syncing site ${siteId}:`, errorMessage);

    return {
      success: false,
      keywordsInserted: 0,
      pagesInserted: 0,
      startDate: "",
      endDate: "",
      error: errorMessage,
    };
  }
}

/**
 * Fetches and refreshes GSC data, one day per transaction, for a site whose
 * ownership and GSC property the caller has already checked. Throws on fetch errors
 * (including ReauthRequiredError) so callers can map them to a response.
 */
export async function runGSCSync(
  userId: string,
  siteId: string,
  gscProperty: string,
  daysBack: number = 28
): Promise<SyncResult> {
  // Refresh both comparison periods. Only completed API responses can establish coverage.
  const { start, end } = getGscDateRange(Math.max(56, daysBack));
  const [queryPages, pages] = await Promise.all([
    fetchSearchAnalytics(userId, gscProperty, start, end, ["query", "page", "date"], undefined, true),
    fetchPageAnalytics(userId, gscProperty, start, end),
  ]);
  const keywords = aggregateByQueryAndDate(queryPages);
  const keywordData = keywords.map(row => ({ siteId, query: row.query, date: gscDate(row.date),
    clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position,
    page: row.page, device: row.device, country: row.country }));
  const pageData = pages.filter(row => row.page).map(row => ({ siteId, url: row.page!, date: gscDate(row.date),
    clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }));
  const detailData = queryPages.filter(row => row.page).map(row => ({ siteId, query: row.query, page: row.page!, date: gscDate(row.date),
    clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }));
  const dates: Date[] = [];
  for (let day = gscDate(start); day <= gscDate(end); day = new Date(day.getTime() + 86400000)) dates.push(day);
  const byDay = <T extends { date: Date }>(rows: T[]) => {
    const map = new Map<number, T[]>();
    for (const row of rows) {
      const list = map.get(row.date.getTime());
      if (list) list.push(row); else map.set(row.date.getTime(), [row]);
    }
    return map;
  };
  const keywordsByDay = byDay(keywordData), pagesByDay = byDay(pageData), detailsByDay = byDay(detailData);
  // Replace one day per transaction, newest first, so a large site never needs one long
  // transaction. Each day's rows and its coverage row commit together: a failure leaves
  // earlier days fully refreshed and later days as they were, and no day looks complete
  // with partial data. Disappeared rows do not survive a refresh of their day.
  for (const day of [...dates].reverse()) {
    const where = { siteId, date: day };
    await db.$transaction(async tx => {
      const [locked] = await tx.$queryRaw<{ userId: string; gscProperty: string | null }[]>`
        SELECT "userId", "gscProperty" FROM "Site" WHERE id = ${siteId} FOR NO KEY UPDATE`;
      if (locked?.userId !== userId || locked.gscProperty !== gscProperty) {
        throw new Error("GSC property or ownership changed during the sync; the remaining days were not written");
      }
      await tx.keyword.deleteMany({ where });
      await tx.page.deleteMany({ where });
      await tx.queryPage.deleteMany({ where });
      await tx.gscSyncCoverage.deleteMany({ where });
      const dayKeywords = keywordsByDay.get(day.getTime()) ?? [];
      const dayPages = pagesByDay.get(day.getTime()) ?? [];
      const dayDetails = detailsByDay.get(day.getTime()) ?? [];
      for (let i = 0; i < dayKeywords.length; i += 500) await tx.keyword.createMany({ data: dayKeywords.slice(i, i + 500) });
      for (let i = 0; i < dayPages.length; i += 500) await tx.page.createMany({ data: dayPages.slice(i, i + 500) });
      for (let i = 0; i < dayDetails.length; i += 500) await tx.queryPage.createMany({ data: dayDetails.slice(i, i + 500) });
      await tx.gscSyncCoverage.createMany({ data: [{ siteId, date: day, gscProperty, pagesComplete: true, queryPagesComplete: true }] });
    }, { timeout: 60000 });
  }
  return {
    success: true, keywordsInserted: keywordData.length, pagesInserted: pageData.length,
    uniqueKeywords: new Set(keywordData.map(row => row.query)).size,
    uniquePages: new Set(pageData.map(row => row.url)).size,
    queryPagesInserted: detailData.length, startDate: start, endDate: end,
  };
}

/**
 * Syncs GSC data for all sites of a user
 */
export async function syncAllUserSites(userId: string): Promise<
  Array<{
    siteId: string;
    domain: string;
    result: SyncResult;
  }>
> {
  const sites = await db.site.findMany({
    where: { userId },
    select: { id: true, domain: true },
  });

  const results = [];

  for (const site of sites) {
    const result = await syncGSCDataForSite(userId, site.id);
    results.push({
      siteId: site.id,
      domain: site.domain,
      result,
    });
  }

  return results;
}
