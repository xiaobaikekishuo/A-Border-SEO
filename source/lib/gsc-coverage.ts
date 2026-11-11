import { db } from "@/lib/db";
import { dateWindow, getGscDateRange } from "@/lib/date-utils";

export function gscComparisonWindows(days = 28) {
  const current = getGscDateRange(days);
  const lastPrevious = new Date(`${current.start}T00:00:00Z`);
  lastPrevious.setUTCDate(lastPrevious.getUTCDate() - 1);
  return { current, previous: dateWindow(days, lastPrevious.toISOString().slice(0, 10)) };
}

/** Coverage means a successful fetch of Google's available rows, not exhaustive query disclosure. */
export async function getGscCoverage(siteId: string, days = 28) {
  const windows = gscComparisonWindows(days);
  const [site, rows] = await Promise.all([
    db.site.findUnique({ where: { id: siteId }, select: { gscProperty: true } }),
    db.gscSyncCoverage.findMany({
      where: { siteId, date: { gte: new Date(`${windows.previous.start}T00:00:00Z`), lte: new Date(`${windows.current.end}T00:00:00Z`) } },
      select: { date: true, gscProperty: true, pagesComplete: true, queryPagesComplete: true, syncedAt: true },
    }),
  ]);
  const valid = rows.filter(row => row.gscProperty === site?.gscProperty);
  const current = valid.filter(row => row.date.toISOString().slice(0, 10) >= windows.current.start);
  const previous = valid.filter(row => row.date.toISOString().slice(0, 10) < windows.current.start);
  const currentDays = current.filter(row => row.pagesComplete).length;
  const previousDays = previous.filter(row => row.pagesComplete).length;
  return { ...windows, expectedDays: days, currentDays, previousDays,
    currentComplete: currentDays === days, previousComplete: previousDays === days,
    comparable: currentDays === days && previousDays === days,
    queryPagesComplete: current.filter(row => row.queryPagesComplete).length === days,
    lastSyncedAt: valid.length ? new Date(Math.max(...valid.map(row => row.syncedAt.getTime()))).toISOString() : null,
  };
}
