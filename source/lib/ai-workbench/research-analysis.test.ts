import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
const auth = vi.hoisted(() => ({ assertPlanConnection: vi.fn() }));
vi.mock("@/lib/chatgpt-connection/service", () => auth);
import { getWorkbenchWorkspace, runWorkbenchAction } from "./data";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { buildWorkbenchPrompt, validateWorkbenchResult } from "./worker";
import { workbenchRequestSchema } from "./schema";
import { assertResearchRequest, parseBacklinkSamples, researchPeriod, validateResearchResult, type ResearchKind } from "./research-analysis";

const now = new Date("2026-11-06T12:00:00Z");
const request = { kind: "DOMAIN_ANALYSIS", provider: "CHATGPT_APP", title: "Own site research", language: "en", profileId: "profile", model: "account-model", planOnlyConfirmed: true, researchAnalysis: { targetMarket: "US readers" } };
const result = { title: "Observed evidence", summary: "A local diagnostic report", contentMarkdown: "P1 is a saved page. Verify context before making changes.", metaTitle: "", metaDescription: "", internalLinks: [], paragraphEdits: [], changeNotes: ["Proposed verification"], factChecks: ["The available evidence is incomplete"] };
let database: TestDb, db: PrismaClient;
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: "research-owner", email: "research@local.test" }, { id: "research-other", email: "other@local.test" }] });
  await db.site.createMany({ data: [{ id: "research-site", userId: "research-owner", domain: "owned.com", gscProperty: "sc-domain:owned.com" }, { id: "research-foreign", userId: "research-other", domain: "foreign.com" }] });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  auth.assertPlanConnection.mockReset().mockResolvedValue({ epoch: 12 });
  await db.aiWorkbenchJob.deleteMany(); await db.crawl.deleteMany(); await db.page.deleteMany(); await db.queryPage.deleteMany(); await db.gscSyncCoverage.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.contentWorkerState.create({ data: { id: "research-worker", lastSeenAt: now } });
  await db.crawl.createMany({ data: [{ id: "research-crawl", siteId: "research-site", status: "COMPLETED", finishedAt: now }, { id: "foreign-crawl", siteId: "research-foreign", status: "COMPLETED", finishedAt: now }] });
  await db.auditPage.createMany({ data: [{ id: "own-page", crawlId: "research-crawl", url: "https://owned.com/guide", title: "Own guide", articleText: "Private body not needed for research", statusCode: 200 }, { id: "foreign-page", crawlId: "foreign-crawl", url: "https://foreign.com/secret", title: "FOREIGN PRIVATE", statusCode: 200 }] });
  await db.auditLink.createMany({ data: [{ crawlId: "research-crawl", sourceUrl: "https://owned.com/guide", targetUrl: "https://reference.com/source", isInternal: false, isNofollow: true, anchorText: "Reference" }, { crawlId: "foreign-crawl", sourceUrl: "https://foreign.com/secret", targetUrl: "https://private-other.com", isInternal: false }] });
});
async function start(kind: ResearchKind = "DOMAIN_ANALYSIS", extra: Record<string, unknown> = {}) {
  const response = await runWorkbenchAction(db, "research-owner", "research-site", { action: "start", ...request, kind, ...extra }, now);
  if (!("jobId" in response)) throw new Error("No job");
  return response.jobId;
}
async function claim() {
  const response = await runWorkerAction(db, { action: "claim", workerId: "research-worker" }, now);
  if (!("job" in response) || !response.job) throw new Error("No job");
  return response.job;
}

describe("research request boundaries", () => {
  it.each(["DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] as const)("requires account authorization and settings for %s", async kind => {
    await expect(runWorkbenchAction(db, "research-other", "research-site", { action: "start", ...request, kind }, now)).rejects.toMatchObject({ status: 404 });
    for (const extra of [{ provider: "CODEX_LOCAL" }, { planOnlyConfirmed: false }, { researchAnalysis: undefined }, { pageId: "own-page" }, { keyword: "seed" }, { keywordResearch: { count: 12, targetMarket: "US" } }]) await expect(start(kind, extra)).rejects.toThrow();
    expect(await db.aiWorkbenchJob.count()).toBe(0);
  });
  it("rejects incompatible research settings on other kinds and domain pasted samples", async () => {
    for (const kind of ["WRITE_ARTICLE", "REWRITE_ARTICLE", "SEO_FIX_PLAN", "KEYWORD_RESEARCH"]) expect(() => assertResearchRequest(workbenchRequestSchema.parse({ ...request, kind }))).toThrow("settings");
    await expect(start("DOMAIN_ANALYSIS", { body: "https://ref.com\thttps://owned.com/guide" })).rejects.toThrow("only supported");
  });
  it("collects only owned local evidence, preserving unknown GSC instead of using partial rows", async () => {
    await db.page.create({ data: { siteId: "research-site", url: "https://owned.com/guide", date: new Date(`${researchPeriod(now).end}T00:00:00Z`), clicks: 8, impressions: 80, ctr: 0.1, position: 4 } });
    const id = await start();
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(job.request).toMatchObject({ connectionEpoch: 12 });
    expect(job.context).toMatchObject({ researchEvidence: { kind: "DOMAIN_ANALYSIS", counters: { totalBacklinks: null }, sources: { gsc: { pagesComplete: false, clicks: null, impressions: null, pageRows: null } } } });
    expect(JSON.stringify(job.context)).not.toMatch(/FOREIGN PRIVATE|foreign.com|Private body/);
    expect(buildWorkbenchPrompt(job.request, job.context)).toContain("not sessions, visits, market search volume");
    const view = await getWorkbenchWorkspace(db, "research-owner", "research-site", now, "DOMAIN_ANALYSIS");
    expect(view.jobs[0].researchEvidence?.pages[0].id).toBe("P1");
    expect(JSON.stringify(view)).not.toMatch(/connectionEpoch|profileId|account-model/);
  });
  it("reports page-row GSC counts only with full dated coverage and preserves true zeros", async () => {
    const period = researchPeriod(now);
    await db.gscSyncCoverage.createMany({ data: Array.from({ length: 28 }, (_, i) => ({ siteId: "research-site", gscProperty: "sc-domain:owned.com", date: new Date(new Date(`${period.start}T00:00:00Z`).getTime() + i * 86400000), pagesComplete: true, queryPagesComplete: true })) });
    await db.page.create({ data: { siteId: "research-site", url: "https://owned.com/guide", date: new Date(`${period.end}T00:00:00Z`), clicks: 0, impressions: 25, ctr: 0, position: 4 } });
    const id = await start();
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(job.context).toMatchObject({ researchEvidence: { sources: { gsc: { period, pagesComplete: true, clicks: 0, impressions: 25, pageRows: 1 } } } });
  });
  it("keeps outgoing crawl records separate from unverified pasted backlinks without granting output links", async () => {
    const id = await start("BACKLINK_ANALYSIS", { body: "https://reference.com/review\thttps://owned.com/unseen\tA claim" });
    const job = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(job.context).toMatchObject({ allowedInternalLinks: ["https://owned.com/guide"], researchEvidence: { counters: { outgoingLinks: 1, sampledOutgoingLinks: 1, backlinkSample: 1, totalBacklinks: null }, sources: { gsc: null }, links: [expect.objectContaining({ id: "O1", direction: "OUTGOING", verified: true }), expect.objectContaining({ id: "B1", direction: "INCOMING_SAMPLE", verified: false, nofollow: null })] } });
    expect(() => validateWorkbenchResult({ ...result, contentMarkdown: "https://owned.com/unseen" }, "owned.com", job.context)).toThrow("verified site URLs");
    expect(() => validateWorkbenchResult({ ...result, contentMarkdown: "https://reference.com/review" }, "owned.com", job.context)).toThrow("verified site URLs");
  });
  it("treats missing crawl and no backlink samples as unknown, not no backlinks", async () => {
    await db.crawl.deleteMany();
    const id = await start("BACKLINK_ANALYSIS");
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).context).toMatchObject({ researchEvidence: { sources: { crawl: null, pastedBacklinks: { count: 0, verified: false } }, counters: { outgoingLinks: null, backlinkSample: 0, totalBacklinks: null } } });
  });
  it.each(["DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] as const)("shares locks and separates history for %s", async kind => {
    const id = await start(kind);
    expect((await getWorkbenchWorkspace(db, "research-owner", "research-site", now)).jobs).toHaveLength(0);
    expect((await getWorkbenchWorkspace(db, "research-owner", "research-site", now, kind)).jobs.map(job => job.id)).toEqual([id]);
    expect((await getWorkbenchWorkspace(db, "research-owner", "research-site", now)).activeTask?.id).toBe(id);
    await expect(start(kind)).rejects.toThrow("active workbench task");
    await expect(runWorkbenchAction(db, "research-owner", "research-site", { action: "start", kind: "WRITE_ARTICLE", title: "Article" }, now)).rejects.toThrow("active workbench task");
    const lease = await claim(); expect(lease).toMatchObject({ provider: "CHATGPT_APP", prompt: "", outputSchema: {} });
    await runWorkerAction(db, { action: "complete", jobId: id, leaseToken: lease.leaseToken, result }, now);
    await expect(runWorkbenchAction(db, "research-owner", "research-site", { action: "saveDraft", jobId: id, expectedUpdatedAt: now.toISOString(), draftText: "Overwrite report" }, now)).rejects.toThrow("cannot be edited");
  });
  it("does not accept late results after user cancellation", async () => {
    const id = await start("BACKLINK_ANALYSIS"); const lease = await claim();
    await runWorkbenchAction(db, "research-owner", "research-site", { action: "cancel", jobId: id }, now);
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: lease.leaseToken, result }, now)).rejects.toMatchObject({ status: 409 });
  });
});

describe("pasted backlink sample parsing", () => {
  it("accepts only inert, bounded source-target rows and keeps verification unknown", () => {
    expect(parseBacklinkSamples("https://reference.com/a\thttps://owned.com/guide\tLabel\n\nhttps://publisher.org/b\thttps://owned.com/other", "owned.com")).toMatchObject([{ id: "B1", verified: false, nofollow: null, anchorText: "Label" }, { id: "B2", verified: false, anchorText: "" }]);
    expect(parseBacklinkSamples("", "owned.com")).toEqual([]);
  });
  it.each([
    "https://reference.com/a", "source\ttarget", "https://reference.com/a\thttps://other.com/guide",
    "https://127.0.0.1/a\thttps://owned.com/guide", "https://localhost/a\thttps://owned.com/guide", "https://host.local/a\thttps://owned.com/guide",
    "http://[::1]/a\thttps://owned.com/guide", "file:///secret\thttps://owned.com/guide", "https://user:pass@reference.com/a\thttps://owned.com/guide",
    "https://www.owned.com/a\thttps://owned.com/guide", "https://blog.owned.com/a\thttps://owned.com/guide", "https://reference.com/a\t/guide",
    "https://reference.com/a\thttps://owned.com/guide\tlabel\textra", "https://reference.com/a\thttp://owned.com/guide",
  ])("rejects invalid sample without echoing URLs or credentials: %s", row => {
    expect(() => parseBacklinkSamples(row, "owned.com")).toThrow("Invalid backlink sample row 1");
  });
  it("rejects excessive count and size", () => {
    expect(() => parseBacklinkSamples(Array(51).fill("https://reference.com/a\thttps://owned.com/guide").join("\n"), "owned.com")).toThrow("50");
    expect(() => parseBacklinkSamples("x".repeat(24001), "owned.com")).toThrow("24000");
  });
  it("rejects publishing fields and article edits in diagnostic output", () => {
    const parsed = workbenchRequestSchema.parse(request);
    expect(() => validateResearchResult({ ...result, metaTitle: "Article title" }, parsed)).toThrow("diagnostic report");
    expect(() => validateResearchResult({ ...result, internalLinks: [{ target: "https://owned.com/guide", anchor: "guide", reason: "Use this" }] }, parsed)).toThrow("diagnostic report");
  });
});
