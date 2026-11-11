import type { PrismaClient } from "@prisma/client";
import { ownedSite } from "./data";
import { importablePage, importPageColumns, sameSitePageUrl } from "./page-evidence";
import { pageQuerySchema } from "./schema";
import type { ImportablePagesResponse } from "./types";

export async function getImportablePages(
  db: PrismaClient, userId: string, siteId: string, input: unknown = {},
): Promise<ImportablePagesResponse> {
  const site = await ownedSite(db, userId, siteId);
  const options = pageQuerySchema.parse(input);
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    select: { id: true, finishedAt: true, pagesFound: true, maxPages: true },
  });
  if (!crawl) return { siteId, crawl: null, rows: [], total: 0, page: options.page, pageSize: options.pageSize };
  const [pages, linked] = await Promise.all([
    db.auditPage.findMany({ where: { crawlId: crawl.id, statusCode: { gte: 200, lt: 300 } }, select: { ...importPageColumns, articleText: true } }),
    db.contentCluster.findMany({ where: { siteId, url: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, url: true, pillar: { select: { title: true } } } }),
  ]);
  const mapped = new Map<string, { id: string; title: string }>();
  for (const row of linked) {
    const url = row.url ? sameSitePageUrl(row.url, site.domain) : null;
    if (url && !mapped.has(url)) mapped.set(url, { id: row.id, title: row.pillar.title });
  }
  const query = options.query.toLocaleLowerCase("en-US");
  const rows = pages.flatMap((page) => {
    const row = importablePage(page, site.domain);
    if (!row || (options.articlesOnly && !row.articleCandidate)) return [];
    if (query && !`${row.title}\n${row.url}`.toLocaleLowerCase("en-US").includes(query)) return [];
    const existing = mapped.get(row.url);
    return [{ ...row, hasArticleText: (page.articleText?.trim().length ?? 0) >= 100, ...(existing ? { existingClusterId: existing.id, existingPillarTitle: existing.title } : {}) }];
  }).sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const start = (options.page - 1) * options.pageSize;
  return {
    siteId,
    crawl: { ...crawl, finishedAt: crawl.finishedAt?.toISOString() ?? null,
      sampleLimited: crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages },
    rows: rows.slice(start, start + options.pageSize), total: rows.length, page: options.page, pageSize: options.pageSize,
  };
}
