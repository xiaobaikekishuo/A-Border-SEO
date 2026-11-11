import type { PrismaClient } from "@prisma/client";
import { metricWindow } from "@/lib/content-planner/data";
import { evaluateGeoPage, GEO_READINESS_VERSION, summarizeGeoPages, type GeoCheckTotals, type GeoPageEvidence } from "./readiness-rules";

/** Pages read for one readiness summary. */
export const READINESS_SAMPLE = 300;
/** At most this many come from Search Console ranking; the rest fill in by URL. */
const RANKED_SAMPLE = 200;

export type GeoReadiness = {
  version: typeof GEO_READINESS_VERSION;
  date: string | undefined;
  /** Indexable HTTP 200 pages in the crawl. */
  total: number;
  sampled: number;
  /** GSC_IMPRESSIONS: the most-seen pages of the last 28 GSC days come first. */
  sampling: "GSC_IMPRESSIONS" | "URL_ORDER";
  rankedPages: number;
  checks: GeoCheckTotals[];
  score: number | null;
};

const pageSelect = {
  url: true, title: true, description: true, h1Count: true, wordCount: true, internalLinks: true,
  articleText: true, articleHeadings: true, schemaReport: true,
} as const;

export async function getReadiness(db: PrismaClient, siteId: string): Promise<GeoReadiness | null> {
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
    select: { id: true, finishedAt: true },
  });
  if (!crawl) return null;
  const where = { crawlId: crawl.id, indexable: true, statusCode: 200 };
  const [total, window] = await Promise.all([db.auditPage.count({ where }), metricWindow(db, siteId)]);
  // Pages people actually see in Google come first, so the score describes them.
  type Ranked = { url: string; _sum: { impressions: number | null } };
  const ranked = window ? await db.page.groupBy({
    by: ["url"],
    where: { siteId, date: { gte: window.start, lte: window.end } },
    _sum: { impressions: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: 1000,
  }) : [];
  const rankedUrls: string[] = ranked.filter((row: Ranked) => (row._sum.impressions ?? 0) > 0).map((row: Ranked) => row.url);
  const rankedPages: GeoPageEvidence[] = rankedUrls.length
    ? await db.auditPage.findMany({ where: { ...where, url: { in: rankedUrls } }, select: pageSelect })
    : [];
  const order = new Map<string, number>(rankedUrls.map((url, index) => [url, index] as [string, number]));
  const first = rankedPages.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0)).slice(0, RANKED_SAMPLE);
  const rest: GeoPageEvidence[] = first.length < READINESS_SAMPLE ? await db.auditPage.findMany({
    where: { ...where, url: { notIn: first.map(page => page.url) } },
    orderBy: [{ url: "asc" }, { id: "asc" }],
    take: READINESS_SAMPLE - first.length,
    select: pageSelect,
  }) : [];
  const pages = [...first, ...rest];
  const { checks, score } = summarizeGeoPages(pages.map(evaluateGeoPage));
  return {
    version: GEO_READINESS_VERSION,
    date: crawl.finishedAt?.toISOString().slice(0, 10),
    total,
    sampled: pages.length,
    sampling: first.length ? "GSC_IMPRESSIONS" : "URL_ORDER",
    rankedPages: first.length,
    checks,
    score,
  };
}
