import type { Prisma, PrismaClient } from "@prisma/client";
import { articleSearchEvidence } from "@/lib/content-planner/article-search-evidence";
import { ContentError } from "@/lib/content-planner/http";
import { siteUrl } from "@/lib/content-planner/schema";
import { visibleIssuesWhere } from "@/lib/crawler/issue-filter";
import { auditIssueDisplayType } from "@/lib/crawler/audit-policy";
import { getGscDateRange } from "@/lib/date-utils";
import { isStructuredDataReport } from "@/lib/seo/structured-data";
import { diagnosticSelectionSchema } from "./schema";
import type { DiagnosticEvidence, DiagnosticSelection } from "./diagnostic-types";

type Db = Pick<Prisma.TransactionClient, "site" | "crawl" | "auditPage" | "crawlIssue" | "queryPage" | "page" | "gscSyncCoverage">;
function sameSite(raw: string, domain: string) {
  try {
    if (!/^https?:\/\//i.test(raw)) throw new Error();
    const url = siteUrl(raw, domain);
    if (!url) throw new Error();
    return url;
  } catch { throw new ContentError("Select an existing URL from this site", 400); }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Read-only evidence collection. Identifiers never authorize an external request. */
export async function collectDiagnosticEvidence(db: Db, site: { id: string; domain: string }, raw: DiagnosticSelection): Promise<DiagnosticEvidence> {
  const selection = diagnosticSelectionSchema.parse(raw);
  const crawl = await db.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true, pagesFound: true, maxPages: true } });
  if (selection.crawlId && selection.crawlId !== crawl?.id) throw new ContentError("The crawl changed. Refresh page evidence before starting a task.", 409);
  const period = getGscDateRange(28);
  const date = { gte: new Date(`${period.start}T00:00:00Z`), lte: new Date(`${period.end}T23:59:59.999Z`) };
  const queryPages = selection.query ? await db.queryPage.groupBy({ by: ["page"], where: { siteId: site.id, query: selection.query, date }, _sum: { impressions: true }, orderBy: { _sum: { impressions: "desc" } }, take: 50 }) : [];
  const candidateUrls = queryPages.flatMap(row => { try { const url = sameSite(row.page, site.domain); return url ? [url] : []; } catch { return []; } });
  const selectedUrl = selection.url ? sameSite(selection.url, site.domain) : null;
  const page = crawl && (selection.pageId || selectedUrl) ? await db.auditPage.findFirst({
    where: { crawlId: crawl.id, ...(selection.pageId ? { id: selection.pageId } : { url: selectedUrl! }) },
    select: { id: true, url: true, title: true, description: true, statusCode: true, canonical: true, indexable: true, robotsMeta: true, noindexSource: true, articleText: true, articleHeadings: true, schemaReport: true },
  }) : null;
  if (selection.pageId && !page) throw new ContentError("Page not found in this site's latest completed crawl", 404);
  if (page) sameSite(page.url, site.domain);
  if (page && selectedUrl && page.url !== selectedUrl) throw new ContentError("Page and URL do not match", 400);
  const url = page?.url ?? selectedUrl;
  if (url && !page && !await db.page.findFirst({ where: { siteId: site.id, url }, select: { id: true } }) && !await db.queryPage.findFirst({ where: { siteId: site.id, page: url }, select: { id: true } })) throw new ContentError("URL has no saved crawl or Search Console evidence for this site", 404);
  if (url && !candidateUrls.includes(url)) candidateUrls.unshift(url);
  candidateUrls.splice(50);
  const observed = crawl && candidateUrls.length ? await db.auditPage.findMany({ where: { crawlId: crawl.id, url: { in: candidateUrls } }, select: { id: true, url: true, title: true, articleText: true } }) : [];
  const searchEvidence = await articleSearchEvidence(db, site.id, url ? [url] : candidateUrls.slice(0, 10), period);
  const focusedRows = url && selection.query && searchEvidence.queryPagesComplete ? await db.queryPage.findMany({ where: { siteId: site.id, page: url, query: selection.query, date }, select: { clicks: true, impressions: true, position: true } }) : [];
  const focusedClicks = focusedRows.reduce((sum, row) => sum + row.clicks, 0);
  const focusedImpressions = focusedRows.reduce((sum, row) => sum + row.impressions, 0);
  const issues = crawl && url ? await db.crawlIssue.findMany({ where: { ...visibleIssuesWhere(crawl.id), url }, orderBy: [{ severity: "asc" }, { id: "asc" }], take: 30, select: { url: true, type: true, severity: true, message: true, details: true } }) : [];
  const report = page?.schemaReport;
  return {
    siteId: site.id, selection: { ...selection, ...(url ? { url } : {}), ...(page ? { pageId: page.id } : {}), ...(crawl ? { crawlId: crawl.id } : {}) },
    limits: { queryCandidates: 50, auditIssues: 30, bodyCharacters: 12000, bodyIsExcerpt: !!page?.articleText, queryCandidatesAtLimit: queryPages.length >= 50, auditIssuesAtLimit: issues.length >= 30 },
    pages: candidateUrls.map(url => { const p = observed.find(item => item.url === url); return { id: p?.id ?? null, url, title: p?.title ?? null, hasBody: (p?.articleText?.trim().length ?? 0) >= 100 }; }),
    page: page ? { id: page.id, url: page.url, title: page.title, description: page.description, statusCode: page.statusCode, canonical: page.canonical, indexable: page.indexable, robotsMeta: page.robotsMeta, noindexSource: page.noindexSource,
      body: page.articleText?.slice(0, 12000) ?? "", bodySource: page.articleText ? "CRAWL" : "NONE", headings: Array.isArray(page.articleHeadings) ? page.articleHeadings.filter((h): h is string => typeof h === "string").slice(0, 30).map(h => h.slice(0, 300)) : [] } : null,
    crawl: crawl ? { id: crawl.id, finishedAt: crawl.finishedAt?.toISOString() ?? null, sampleLimited: crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages } : null,
    issues: issues.map(issue => ({ type: auditIssueDisplayType({ ...issue, details: object(issue.details) }), severity: issue.severity, message: issue.message.slice(0, 1000), disposition: object(object(issue.details).auditPolicy).disposition === "unverified" ? "unverified" : "observed" })),
    searchEvidence,
    queryEvidence: selection.query && url ? { query: selection.query, status: !searchEvidence.queryPagesComplete ? "UNKNOWN" : focusedRows.length ? "REPORTED" : "NO_RECORDED_ROWS", clicks: focusedRows.length ? focusedClicks : null, impressions: focusedRows.length ? focusedImpressions : null, ctr: focusedImpressions > 0 ? focusedClicks / focusedImpressions : null, position: focusedImpressions > 0 ? focusedRows.reduce((sum, row) => sum + row.position * row.impressions, 0) / focusedImpressions : null } : null,
    schemaReport: isStructuredDataReport(report) ? report as DiagnosticEvidence["schemaReport"] : null,
  };
}

export async function getDiagnosticEvidence(db: PrismaClient, userId: string | null | undefined, siteId: string, raw: unknown) {
  if (!userId) throw new ContentError("Unauthorized", 401);
  const site = await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true, domain: true } });
  if (!site) throw new ContentError("Not found", 404);
  return collectDiagnosticEvidence(db, site, diagnosticSelectionSchema.parse(raw));
}
