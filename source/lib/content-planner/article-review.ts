import { articleSearchEvidence } from "./article-search-evidence";
import { Prisma } from "@prisma/client";
import { ContentError } from "./http";
import { articleReviewRequestSchema, validateArticleReview } from "./article-review-schema";
import { briefSchema, dedupeKey } from "./schema";
import { importablePage, importPageColumns, sameSitePageUrl } from "./page-evidence";

type Tx = Prisma.TransactionClient;
type Site = { id: string; domain: string };
const json = (value: unknown) => value as Prisma.InputJsonValue;
export async function startArticleReview(tx: Tx, site: Site, pageIds: string[], pastedText: Record<string, string>) {
  if (await tx.contentPlanJob.count({ where: { siteId: site.id, status: { in: ["QUEUED", "RUNNING"] } } })) throw new ContentError("A content plan is already queued or running for this site", 409);
  const pillars = await tx.contentPillar.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, keyword: true, description: true } });
  if (!pillars.length) throw new ContentError("Create a pillar before reviewing articles");
  const crawl = await tx.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED" }, orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }], select: { id: true, finishedAt: true } });
  if (!crawl) throw new ContentError("No completed crawl is available for this site", 409);
  const ids = [...new Set(pageIds)];
  const pages = await tx.auditPage.findMany({ where: { crawlId: crawl.id, id: { in: ids } }, select: { ...importPageColumns, articleText: true, articleHeadings: true } });
  if (pages.length !== ids.length) throw new ContentError("Selected articles are no longer in the latest crawl. Reload the inventory.", 409);
  const clusters = await tx.contentCluster.findMany({ where: { siteId: site.id, url: { not: null } }, select: { id: true, url: true, updatedAt: true } });
  const known = await tx.auditPage.findMany({ where: { crawlId: crawl.id, statusCode: 200, indexable: true }, select: { url: true } });
  const searchEvidence = await articleSearchEvidence(tx, site.id, pages.map(page => page.url));
  const request = articleReviewRequestSchema.parse({
    searchEvidence,
    pages: pages.map(page => {
      const row = importablePage(page, site.domain);
      if (!row) throw new ContentError("Selected article is not an eligible site page");
      const text = (pastedText[page.id]?.trim() || page.articleText?.trim() || "").slice(0, 12000);
      if (text.length < 100) throw new ContentError("Article body is missing. Paste at least 100 characters or run a new crawl.", 409);
      const existing = clusters.find(cluster => cluster.url && sameSitePageUrl(cluster.url, site.domain) === row.url);
      return { pageId: page.id, url: row.url, title: row.title, text, headings: !pastedText[page.id]?.trim() && Array.isArray(page.articleHeadings) ? page.articleHeadings.filter((heading): heading is string => typeof heading === "string") : [], source: pastedText[page.id]?.trim() ? "PASTED" : "CRAWL", existingClusterId: existing?.id ?? null, existingUpdatedAt: existing?.updatedAt.toISOString() ?? null };
    }), pillars, crawlAt: crawl.finishedAt?.toISOString() ?? null,
    allowedInternalLinks: known.flatMap(page => { const url = sameSitePageUrl(page.url, site.domain); return url ? [url] : []; }),
  });
  const job = await tx.contentPlanJob.create({ data: { siteId: site.id, pillarId: pillars[0].id, kind: "ARTICLE_REVIEW", topicCount: ids.length, activeKey: site.id, request: json(request) }, select: { id: true } });
  return { ok: true, job };
}

export async function applyArticleReview(tx: Tx, site: Site, jobId: string, pageIds: string[], now: Date) {
  const job = await tx.contentPlanJob.findFirst({ where: { id: jobId, siteId: site.id, kind: "ARTICLE_REVIEW" } });
  if (!job) throw new ContentError("Plan not found", 404);
  if (job.appliedAt) return { ok: true, updated: 0, imported: 0, alreadyApplied: true };
  if (job.status !== "SUCCEEDED") throw new ContentError("The plan is not ready to apply", 409);
  const request = articleReviewRequestSchema.parse(job.request);
  const review = validateArticleReview(job.result, request);
  const selected = [...new Set(pageIds)];
  if (selected.some(id => !review.articles.some(article => article.pageId === id))) throw new ContentError("Selected article is not in this review");
  let updated = 0; let imported = 0;
  for (const pageId of selected) {
    const article = review.articles.find(value => value.pageId === pageId)!;
    const page = request.pages.find(value => value.pageId === pageId)!;
    if (!await tx.contentPillar.findFirst({ where: { id: article.pillarId, siteId: site.id } })) throw new ContentError("Pillar not found", 409);
    const old = page.existingClusterId ? await tx.contentCluster.findFirst({ where: { id: page.existingClusterId, siteId: site.id } }) : null;
    if (page.existingClusterId && (!old || old.updatedAt.toISOString() !== page.existingUpdatedAt)) throw new ContentError("An article was edited after this review started. Generate a new review to preserve your changes.", 409);
    if (!old && await tx.contentCluster.findFirst({ where: { siteId: site.id, url: page.url } })) throw new ContentError("This article was imported after the review started. Generate a new review.", 409);
    const key = dedupeKey(article.keyword);
    if (await tx.contentCluster.findFirst({ where: { pillarId: article.pillarId, dedupeKey: key, ...(old ? { id: { not: old.id } } : {}) } })) throw new ContentError("A topic with this keyword already exists in the selected pillar", 409);
    const brief = { summary: article.reason, audience: "Existing article readers", searchIntent: article.keyword, angle: article.reason, outline: [...page.headings.slice(0, 10), "Update tasks"], keyPoints: [...article.keep.map(value => `KEEP: ${value}`.slice(0, 1000)), ...article.add.map(value => `ADD: ${value}`.slice(0, 1000)), ...article.rewrite.map(value => `REWRITE: ${value}`.slice(0, 1000))].slice(0, 15), cta: "Review the proposed changes, then update the website in your CMS.", internalLinks: article.internalLinks.map(link => ({ target: link.target, title: link.anchor, reason: `${link.sourceSection}: ${link.reason}`.slice(0, 1000) })), evidenceNotes: [`Body source: ${page.source}; excerpt up to 12000 characters.`, `Classification confidence: ${article.confidence}.`, `Source URL: ${page.url}`.slice(0, 1500)] };
    if (!brief.keyPoints.length) brief.keyPoints.push("No specific text changes proposed; verify the classification.");
    briefSchema.parse(brief);
    const optimization = { acceptedAt: now.toISOString(), sourceUrl: page.url, bodySource: page.source, crawlAt: request.crawlAt, review: article, previousBrief: old?.brief ?? null, websiteUpdatedAt: null };
    if (old) {
      const changed = await tx.contentCluster.updateMany({ where: { id: old.id, siteId: site.id, updatedAt: old.updatedAt }, data: { pillarId: article.pillarId, keyword: article.keyword, dedupeKey: key, funnel: article.funnel, brief: json(brief), optimization: json(optimization), updatedAt: now } });
      if (changed.count !== 1) throw new ContentError("An article was edited after this review started. Generate a new review to preserve your changes.", 409);
      updated++;
    } else {
      await tx.contentCluster.create({ data: { siteId: site.id, pillarId: article.pillarId, title: page.title, keyword: article.keyword, dedupeKey: key, funnel: article.funnel, url: page.url, status: "PUBLISHED", contentType: "Article", source: "AI", brief: json(brief), optimization: json(optimization) } }); imported++;
    }
  }
  await tx.contentPlanJob.update({ where: { id: job.id }, data: { appliedAt: now } });
  return { ok: true, updated, imported, alreadyApplied: false };
}
