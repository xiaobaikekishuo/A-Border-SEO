import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
const auth = vi.hoisted(() => ({ assertPlanConnection: vi.fn() }));
vi.mock("@/lib/chatgpt-connection/service", () => auth);
import { getWorkbenchWorkspace, runWorkbenchAction } from "./data";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { buildWorkbenchPrompt, validateWorkbenchResult } from "./worker";
import { generationSchemaFor, keywordIdeaSchema, workbenchRequestSchema } from "./schema";
import { validateKeywordIdeas } from "./keyword-research";

let database: TestDb; let db: PrismaClient;
const now = new Date("2026-11-06T04:00:00Z");
const request = { provider: "CHATGPT_APP", profileId: "kw-profile", model: "test-account-model", planOnlyConfirmed: true, kind: "KEYWORD_RESEARCH", title: "Apple ID", keyword: "Apple ID", language: "en", keywordResearch: { count: 12, targetMarket: "United States" } };
const idea = { keyword: "Apple ID region", intent: "INFORMATIONAL" as const, funnel: "TOFU" as const, cluster: "Account regions", angle: "Explain region settings", rationale: "Inferred from the seed; verify search demand" };
const result = { title: "Keyword candidates", summary: "Proposed ideas, not measured demand", contentMarkdown: "Review these suggestions and verify real metrics.", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["Verify demand and search intent"], internalLinks: [], paragraphEdits: [], keywordIdeas: [idea] };
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: "kw-owner", email: "kw@local.test" }, { id: "kw-other", email: "other@local.test" }] });
  await db.site.createMany({ data: [{ id: "kw-site", userId: "kw-owner", domain: "keyword.test" }, { id: "kw-foreign", userId: "kw-other", domain: "foreign.test" }] });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  auth.assertPlanConnection.mockReset().mockResolvedValue({ epoch: 8 });
  await db.aiWorkbenchJob.deleteMany(); await db.crawl.deleteMany(); await db.savedKeyword.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.contentWorkerState.create({ data: { id: "kw-worker", lastSeenAt: now } });
  await db.crawl.createMany({ data: [{ id: "kw-crawl", siteId: "kw-site", status: "COMPLETED", finishedAt: now }, { id: "kw-foreign-crawl", siteId: "kw-foreign", status: "COMPLETED", finishedAt: now }] });
  await db.auditPage.createMany({ data: [{ id: "kw-page", crawlId: "kw-crawl", url: "https://keyword.test/guide", statusCode: 200, indexable: true, title: "Apple ID basics", articleText: "Never send this unused private body" }, { id: "kw-foreign-page", crawlId: "kw-foreign-crawl", url: "https://foreign.test/private", statusCode: 200, indexable: true, title: "Foreign private information" }] });
  await db.savedKeyword.createMany({ data: [{ siteId: "kw-site", query: "Saved local topic" }, { siteId: "kw-foreign", query: "Foreign saved topic" }] });
});
async function start(extra: Record<string, unknown> = {}) {
  const response = await runWorkbenchAction(db, "kw-owner", "kw-site", { action: "start", ...request, ...extra }, now);
  if (!("jobId" in response)) throw new Error("No job");
  return response.jobId;
}
async function claim() {
  const response = await runWorkerAction(db, { action: "claim", workerId: "kw-worker" }, now);
  if (!("job" in response) || !response.job) throw new Error("No job");
  return response.job;
}

describe("account keyword research", () => {
  it("requires owner, app account, confirmation, seed and settings before creating a task", async () => {
    await expect(runWorkbenchAction(db, "kw-other", "kw-site", { action: "start", ...request }, now)).rejects.toMatchObject({ status: 404 });
    for (const extra of [{ provider: "CODEX_LOCAL" }, { planOnlyConfirmed: false }, { keyword: " " }, { keywordResearch: undefined }, { keywordResearch: { count: 100, targetMarket: "US" } }, { body: "Unneeded article" }, { pageId: "kw-page" }]) await expect(start(extra)).rejects.toThrow();
    expect(await db.aiWorkbenchJob.count()).toBe(0);
  });
  it("pins account epoch and takes only bounded local evidence, without article bodies or foreign data", async () => {
    const id = await start();
    expect(auth.assertPlanConnection).toHaveBeenCalledWith("kw-owner", "kw-profile");
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(job.request).toMatchObject({ connectionEpoch: 8, keywordResearch: { count: 12, targetMarket: "United States" } });
    expect(job.context).toMatchObject({ body: "", savedKeywords: ["Saved local topic"], knownPages: [{ url: "https://keyword.test/guide", title: "Apple ID basics" }], searchEvidence: { pagesComplete: false, queryPagesComplete: false } });
    expect(JSON.stringify(job.context)).not.toMatch(/Foreign|foreign|unused private body/);
    const claimed = await claim(); expect(claimed).toMatchObject({ provider: "CHATGPT_APP", prompt: "", outputSchema: {} });
    expect(buildWorkbenchPrompt(job.request, job.context)).toContain("not market search volume");
    expect(await db.savedKeyword.count({ where: { siteId: "kw-site" } })).toBe(1);
  });
  it("separates history before applying limits while reporting the shared active task", async () => {
    await db.aiWorkbenchJob.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ id: `aw_article_${i}`, siteId: "kw-site", kind: "WRITE_ARTICLE", title: "Existing draft", request: {}, context: {}, status: "SUCCEEDED" as const, createdAt: new Date(now.getTime() + i) })) });
    const id = await start();
    const keywordView = await getWorkbenchWorkspace(db, "kw-owner", "kw-site", now, "KEYWORD_RESEARCH");
    const workbench = await getWorkbenchWorkspace(db, "kw-owner", "kw-site", now);
    expect(keywordView.jobs.map(job => job.id)).toEqual([id]); expect(workbench.jobs).toHaveLength(20);
    expect(workbench.jobs.every(job => job.kind !== "KEYWORD_RESEARCH")).toBe(true);
    expect(workbench.activeTask).toEqual({ id, kind: "KEYWORD_RESEARCH", title: "Apple ID" });
    await expect(start({ kind: "WRITE_ARTICLE", keywordResearch: undefined })).rejects.toThrow("active workbench task");
  });
  it("validates candidates before completion, stores existing usage, and never auto-saves keywords", async () => {
    const id = await start(); const lease = await claim();
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: lease.leaseToken, result: { ...result, keywordIdeas: [{ ...idea, volume: 1000 }] } }, now)).rejects.toThrow();
    await runWorkerAction(db, { action: "complete", jobId: id, leaseToken: lease.leaseToken, result }, now);
    expect(await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SUCCEEDED", result });
    expect(await db.savedKeyword.count({ where: { siteId: "kw-site" } })).toBe(1);
    expect((await getWorkbenchWorkspace(db, "kw-owner", "kw-site", now, "KEYWORD_RESEARCH")).jobs[0].result?.keywordIdeas).toEqual([idea]);
  });
  it("shares cancellation protections and rejects late keyword output", async () => {
    const id = await start(); const lease = await claim();
    await runWorkbenchAction(db, "kw-owner", "kw-site", { action: "cancel", jobId: id }, now);
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: lease.leaseToken, result }, now)).rejects.toMatchObject({ status: 409 });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).result).toBeNull();
  });
});
describe("keyword output contract", () => {
  it("requires candidate output only for keyword tasks without changing older article schemas", () => {
    expect(generationSchemaFor("KEYWORD_RESEARCH").safeParse({ ...result, keywordIdeas: undefined }).success).toBe(false);
    const { keywordIdeas: _ideas, ...historicalArticle } = result;
    expect(generationSchemaFor("WRITE_ARTICLE").safeParse(historicalArticle).success).toBe(true);
    expect(keywordIdeaSchema.safeParse({ ...idea, cpc: 2 }).success).toBe(false);
  });
  it("rejects duplicate variants, excess counts, article fields and unknown links in candidates", () => {
    const parsed = workbenchRequestSchema.parse(request);
    expect(() => validateKeywordIdeas({ ...result, keywordIdeas: [idea, { ...idea, keyword: " APPLE   ID region " }] }, parsed)).toThrow("duplicate");
    expect(() => validateKeywordIdeas({ ...result, keywordIdeas: Array.from({ length: 13 }, (_, i) => ({ ...idea, keyword: `Topic ${i}` })) }, parsed)).toThrow("count");
    expect(() => validateKeywordIdeas({ ...result, metaTitle: "Publish me" }, parsed)).toThrow("publishing");
    expect(() => validateWorkbenchResult({ ...result, keywordIdeas: [{ ...idea, rationale: "Visit https://invented.test/" }] }, "keyword.test", { allowedInternalLinks: [] })).toThrow("verified site URLs");
    expect(() => validateKeywordIdeas(result, workbenchRequestSchema.parse({ kind: "WRITE_ARTICLE", title: "Article" }))).toThrow("only supported");
  });
});
