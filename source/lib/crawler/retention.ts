import { Prisma, type PrismaClient } from "@prisma/client";

/** Completed crawls per site that keep their full page evidence. */
export const DEFAULT_DETAIL_RETENTION = 3;

/** CRAWL_DETAIL_RETENTION, at least 2 so the latest crawl can still be compared with the one before. */
export function crawlDetailRetention(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.CRAWL_DETAIL_RETENTION?.trim());
  return Number.isInteger(value) && value >= 2 && value <= 100 ? value : DEFAULT_DETAIL_RETENTION;
}

/**
 * Clears the bulky per-page evidence (main text excerpt, headings and the
 * structured data report) of a site's older completed crawls, keeping the
 * newest `keep`. Titles, status codes, issues, links and scores stay, so
 * history and trends are unchanged; only those older pages show the evidence
 * as not collected. Returns how many page rows were cleared.
 */
export async function pruneCrawlDetails(
  db: Pick<PrismaClient, "crawl" | "auditPage">,
  siteId: string,
  keep = crawlDetailRetention(),
): Promise<number> {
  const completed = await db.crawl.findMany({
    where: { siteId, status: "COMPLETED" },
    orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const older = completed.slice(keep).map((crawl: { id: string }) => crawl.id);
  if (!older.length) return 0;
  const result = await db.auditPage.updateMany({
    where: {
      crawlId: { in: older },
      OR: [{ articleText: { not: null } }, { articleHeadings: { not: Prisma.DbNull } }, { schemaReport: { not: Prisma.DbNull } }],
    },
    data: { articleText: null, articleHeadings: Prisma.DbNull, schemaReport: Prisma.DbNull },
  });
  return result.count;
}
