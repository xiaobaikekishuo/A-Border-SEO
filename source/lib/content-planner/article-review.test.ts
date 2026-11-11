import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runContentAction, getContentWorkspace } from "./data";
import { runWorkerAction } from "./worker";
import { articleReviewRequestSchema, validateArticleReview } from "./article-review-schema";
import { optimizationEvidence } from "./optimization-evidence";
import { articleExcerpt } from "@/lib/crawler/article-excerpt";

let database: TestDb; let db: PrismaClient;
const siteId = "review-site"; const userId = "review-owner"; const url = "https://review.example/blog/guide";
const now = new Date("2026-11-05T02:00:00Z");
const review = () => ({ summary: "Review existing guide", articles: [{ pageId: "review-page", pillarId: "review-pillar", keyword: "guide", funnel: "MOFU", confidence: "MEDIUM", reason: "The Comparison section compares options.", keep: ["Keep the introduction."], add: ["Add a proposed Requirements section."], rewrite: ["Clarify the Comparison section."], internalLinks: [{ target: "https://review.example/blog/related", sourceSection: "Comparison", anchor: "related guide", reason: "Explain the alternative." }] }] });
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: userId, email: "review@review.example" }, { id: "foreign-review", email: "other@review.example" }] });
  await db.site.create({ data: { id: siteId, userId, domain: "review.example" } });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.contentPillar.deleteMany(); await db.crawl.deleteMany();
  await db.contentPillar.create({ data: { id: "review-pillar", siteId, title: "Useful guides", keyword: "guides" } });
  await db.crawl.create({ data: { id: "review-crawl", siteId, status: "COMPLETED", finishedAt: now, pagesFound: 2 } });
  await db.auditPage.createMany({ data: [{ id: "review-page", crawlId: "review-crawl", url, statusCode: 200, title: "Original title", wordCount: 200, articleText: "Comparison: choose between two approaches. ".repeat(10), articleHeadings: ["Comparison"] }, { id: "related-page", crawlId: "review-crawl", url: "https://review.example/blog/related", statusCode: 200, title: "Related", wordCount: 200 }] });
});
async function generated() {
  await runContentAction(db, userId, siteId, { action: "startArticleReview", pageIds: ["review-page"] }, now);
  const claimed = await runWorkerAction(db, { action: "claim", workerId: "review-test" }, now);
  if (!("job" in claimed) || !claimed.job) throw new Error("No claimed job");
  expect(claimed.job.prompt).toContain("Comparison: choose between two approaches");
  await runWorkerAction(db, { action: "complete", jobId: claimed.job.jobId, leaseToken: claimed.job.leaseToken, result: review() }, now);
  return claimed.job.jobId;
}
describe("existing article review", () => {
  it("rejects foreign sites and missing body without queuing generation", async () => {
    await expect(runContentAction(db, "foreign-review", siteId, { action: "startArticleReview", pageIds: ["review-page"] })).rejects.toMatchObject({ status: 404 });
    await db.auditPage.update({ where: { id: "review-page" }, data: { articleText: null } });
    await expect(runContentAction(db, userId, siteId, { action: "startArticleReview", pageIds: ["review-page"] })).rejects.toThrow("Article body is missing");
    expect(await db.contentPlanJob.count()).toBe(0);
  });
  it("uses pasted text as untrusted evidence without borrowing stale headings", async () => {
    await runContentAction(db, userId, siteId, { action: "startArticleReview", pageIds: ["review-page"], pastedText: { "review-page": "A new pasted article about options. ".repeat(10) } }, now);
    const job = await db.contentPlanJob.findFirstOrThrow();
    const request = articleReviewRequestSchema.parse(job.request);
    expect(request.pages[0]).toMatchObject({ source: "PASTED", headings: [] });
    const bad = review(); bad.articles[0].internalLinks[0].target = "https://elsewhere.example/private";
    expect(() => validateArticleReview(bad, request)).toThrow("verified URL");
  });
  it("requires review, applies once, and preserves existing title, URL, publishing and schedule", async () => {
    await db.contentCluster.create({ data: { id: "review-cluster", siteId, pillarId: "review-pillar", title: "My edited title", keyword: "old keyword", dedupeKey: "old keyword", funnel: "TOFU", url, status: "PUBLISHED", scheduledFor: now } });
    const jobId = await generated();
    expect((await db.contentCluster.findUniqueOrThrow({ where: { id: "review-cluster" } })).funnel).toBe("TOFU");
    const result = await runContentAction(db, userId, siteId, { action: "applyArticleReview", jobId, pageIds: ["review-page"] }, now);
    expect(result).toMatchObject({ updated: 1, imported: 0 });
    const row = await db.contentCluster.findUniqueOrThrow({ where: { id: "review-cluster" } });
    expect(row).toMatchObject({ title: "My edited title", url, status: "PUBLISHED", scheduledFor: now, funnel: "MOFU" });
    expect(row.optimization).toMatchObject({ acceptedAt: now.toISOString(), websiteUpdatedAt: null });
    expect(await runContentAction(db, userId, siteId, { action: "applyArticleReview", jobId, pageIds: ["review-page"] }, now)).toMatchObject({ alreadyApplied: true });
    await runContentAction(db, userId, siteId, { action: "recordWebsiteUpdate", clusterId: row.id }, now);
    const workspace = await getContentWorkspace(db, userId, siteId, now);
    expect(workspace.pillars[0].clusters[0].updateOutcome).toMatchObject({ websiteUpdatedAt: now.toISOString(), baseline: null, after: null });
    expect(workspace.jobs[0].result).toBeNull();
    expect(workspace.jobs[0].reviewResult?.articles).toHaveLength(1);
    expect(workspace.jobs[0]).not.toHaveProperty("request");
  });
  it("protects edits made after the generation snapshot and rolls back apply", async () => {
    await db.contentCluster.create({ data: { id: "review-cluster", siteId, pillarId: "review-pillar", title: "Original", keyword: "old", dedupeKey: "old", funnel: "TOFU", url } });
    const jobId = await generated();
    await db.contentCluster.update({ where: { id: "review-cluster" }, data: { title: "New manual edit", updatedAt: new Date(now.getTime() + 5000) } });
    await expect(runContentAction(db, userId, siteId, { action: "applyArticleReview", jobId, pageIds: ["review-page"] }, now)).rejects.toThrow("edited after");
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: jobId } })).appliedAt).toBeNull();
  });
  it("does not call pre-acceptance evidence a verified link", () => {
    const value = { acceptedAt: now.toISOString(), sourceUrl: url, bodySource: "CRAWL", review: review().articles[0] };
    const pages = new Set([url]); const links = new Set([JSON.stringify([url, "https://review.example/blog/related"])]);
    expect(optimizationEvidence(value, url, pages, links, now)?.links[0].status).toBe("NOT_CHECKED");
    expect(optimizationEvidence(value, url, pages, links, new Date(now.getTime() + 1000))?.links[0].status).toBe("OBSERVED");
    expect(optimizationEvidence(value, url, pages, new Set(), new Date(now.getTime() + 1000))?.links[0].status).toBe("NOT_OBSERVED");
  });
  it("extracts bounded article evidence and excludes navigation and executable code", () => {
    const value = articleExcerpt(`<nav>Menu secret</nav><article><h2>Comparison</h2><p>${"body ".repeat(4000)}</p><script>leak()</script></article>`);
    expect(value.articleText.length).toBe(12000); expect(value.articleHeadings).toEqual(["Comparison"]);
    expect(value.articleText).not.toContain("leak"); expect(value.articleText).not.toContain("Menu");
  });
});
