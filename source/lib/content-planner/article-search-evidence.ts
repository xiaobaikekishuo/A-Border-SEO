import type { Prisma } from "@prisma/client";
import { getGscDateRange } from "@/lib/date-utils";

type Db = Pick<Prisma.TransactionClient, "site" | "gscSyncCoverage" | "page" | "queryPage">;
/** Unknown coverage and unreported URLs stay unknown, including when Google suppresses query rows. */
export async function articleSearchEvidence(db: Db, siteId: string, urls: string[], period = getGscDateRange(28)) {
  const date = { gte: new Date(`${period.start}T00:00:00Z`), lte: new Date(`${period.end}T23:59:59.999Z`) };
  const site = await db.site.findUnique({ where: { id: siteId }, select: { gscProperty: true } });
  const coverage = site?.gscProperty ? await db.gscSyncCoverage.findMany({ where: { siteId, gscProperty: site.gscProperty, date }, select: { pagesComplete: true, queryPagesComplete: true } }) : [];
  const pagesComplete = coverage.filter(row => row.pagesComplete).length === 28;
  const queryPagesComplete = coverage.filter(row => row.queryPagesComplete).length === 28;
  const [rows, queries] = await Promise.all([
    pagesComplete ? db.page.findMany({ where: { siteId, url: { in: urls }, date }, select: { url: true, clicks: true, impressions: true } }) : [],
    queryPagesComplete ? db.queryPage.groupBy({ by: ["page", "query"], where: { siteId, page: { in: urls }, date }, _sum: { clicks: true, impressions: true }, orderBy: { _sum: { impressions: "desc" } }, take: 100 }) : [],
  ]);
  return { period, pagesComplete, queryPagesComplete, pages: urls.map(url => {
    const found = rows.filter(row => row.url === url);
    const observedQueries = queries.filter(row => row.page === url).slice(0, 10).map(row => ({ query: row.query, clicks: row._sum.clicks ?? 0, impressions: row._sum.impressions ?? 0 }));
    return { url, status: !pagesComplete ? "UNKNOWN" as const : found.length ? "REPORTED" as const : "NO_RECORDED_ROWS" as const,
      clicks: found.length ? found.reduce((sum, row) => sum + row.clicks, 0) : null,
      impressions: found.length ? found.reduce((sum, row) => sum + row.impressions, 0) : null,
      queryStatus: !queryPagesComplete ? "UNKNOWN" as const : observedQueries.length ? "REPORTED_SAMPLE" as const : "NO_RECORDED_ROWS" as const,
      queries: observedQueries };
  }) };
}
