import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { getWorkbenchWorkspace, runWorkbenchAction } from "./data";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { validateWorkbenchResult } from "./worker";

let database: TestDb; let db: PrismaClient;
const now = new Date("2026-11-05T04:00:00Z");
const user = "aw-owner"; const site = "aw-site"; const url = "https://workbench.example/guide";
const input = { action: "start", kind: "WRITE_ARTICLE", title: "A useful guide", language: "en", instructions: "Explain the topic", keyword: "guide" };
const result = () => ({ title: "A useful guide", summary: "An editable draft", contentMarkdown: "# A useful guide\n\nReview these proposed changes.", metaTitle: "Useful guide", metaDescription: "A draft description", changeNotes: ["Clarify the introduction"], factChecks: ["Review all facts before publishing"], internalLinks: [{ target: url, anchor: "guide", reason: "Further detail" }] });
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: user, email: "aw@workbench.example" }, { id: "aw-other", email: "foreign@workbench.example" }] });
  await db.site.createMany({ data: [{ id: site, userId: user, domain: "workbench.example", gscProperty: "sc-domain:workbench.example" }, { id: "aw-other-site", userId: "aw-other", domain: "other.example" }] });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.aiWorkbenchJob.deleteMany(); await db.contentPillar.deleteMany(); await db.crawl.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.contentWorkerState.create({ data: { id: "aw-worker", lastSeenAt: now } });
  await db.crawl.create({ data: { id: "aw-crawl", siteId: site, status: "COMPLETED", finishedAt: now } });
  await db.crawl.create({ data: { id: "aw-foreign-crawl", siteId: "aw-other-site", status: "COMPLETED", finishedAt: now } });
  await db.auditPage.createMany({ data: [{ id: "aw-page", crawlId: "aw-crawl", url, statusCode: 200, title: "A useful guide", articleText: "Supported body facts about the topic. ".repeat(10) }, { id: "aw-foreign-page", crawlId: "aw-foreign-crawl", url: "https://other.example/private", statusCode: 200, articleText: "Never share this foreign page body. ".repeat(10) }] });
});
async function start(raw: unknown = input) {
  const response = await runWorkbenchAction(db, user, site, raw, now);
  if (!("jobId" in response)) throw new Error("No task ID");
  return response.jobId;
}
async function claim() {
  const response = await runWorkerAction(db, { action: "claim", workerId: "aw-worker" }, now);
  if (!("job" in response) || !response.job) throw new Error("No claimed task");
  return response.job;
}
async function finish() {
  const id = await start(); const job = await claim();
  await runWorkerAction(db, { action: "complete", jobId: id, leaseToken: job.leaseToken, result: result() }, now);
  return db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
}
describe("local account workbench", () => {
  it("rejects anonymous and foreign owners and cross-site source IDs", async () => {
    await expect(getWorkbenchWorkspace(db, null, site, now)).rejects.toMatchObject({ status: 401 });
    await expect(runWorkbenchAction(db, "aw-other", site, input, now)).rejects.toMatchObject({ status: 404 });
    await expect(start({ ...input, pageId: "aw-foreign-page" })).rejects.toMatchObject({ status: 404 });
    await expect(start({ ...input, clusterId: "foreign-topic" })).rejects.toMatchObject({ status: 404 });
    expect(await db.aiWorkbenchJob.count()).toBe(0);
  });
  it("requires captured or pasted body for rewriting and never fetches a URL", async () => {
    await expect(start({ ...input, kind: "REWRITE_ARTICLE" })).rejects.toThrow("body is missing");
    const id = await start({ ...input, kind: "REWRITE_ARTICLE", pageId: "aw-page", body: "Replacement source facts. ".repeat(10) });
    const stored = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(stored.context).toMatchObject({ bodySource: "PASTED", searchEvidence: { pagesComplete: false } });
    const job = await claim(); expect(job.prompt).toContain("Replacement source facts"); expect(job.prompt).toContain("Never say that a fix was applied");
    expect(job.prompt).not.toContain("Never share this foreign page body");
  });
  it("rejects offline generation and serializes concurrent starts per site", async () => {
    await db.contentWorkerState.deleteMany(); await expect(start()).rejects.toThrow("offline");
    await db.contentWorkerState.create({ data: { id: "aw-worker", lastSeenAt: now } });
    const starts = await Promise.allSettled([start(), start()]);
    expect(starts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(await db.aiWorkbenchJob.count()).toBe(1);
  });
  it("claims the oldest job across both queues and does not change old plans", async () => {
    await db.contentPillar.create({ data: { id: "aw-pillar", siteId: site, title: "Guides", keyword: "guide" } });
    await db.contentPlanJob.create({ data: { id: "old-plan", siteId: site, pillarId: "aw-pillar", createdAt: new Date(now.getTime() - 1000), activeKey: site } });
    const id = await start(); expect((await claim()).jobId).toBe("old-plan");
    expect((await claim()).jobId).toBe(id);
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: "old-plan" } })).result).toBeNull();
  });
  it("allows only one claim and rejects foreign or expired leases", async () => {
    const id = await start(); const claims = await Promise.all([runWorkerAction(db, { action: "claim", workerId: "a" }, now), runWorkerAction(db, { action: "claim", workerId: "b" }, now)]);
    const jobs = claims.flatMap(row => "job" in row && row.job ? [row.job] : []); expect(jobs).toHaveLength(1);
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: "wrong", result: result() }, now)).rejects.toMatchObject({ status: 409 });
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: jobs[0].leaseToken, result: result() }, new Date(now.getTime() + 121000))).rejects.toMatchObject({ status: 409 });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).result).toBeNull();
  });
  it("renews a live heartbeat but cannot extend the maximum execution time", async () => {
    const id = await start(); const job = await claim();
    await runWorkerAction(db, { action: "heartbeat", jobId: id, leaseToken: job.leaseToken, workerId: "aw-worker" }, new Date(now.getTime() + 60000));
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: job.leaseToken, result: result() }, new Date(now.getTime() + 150000))).resolves.toEqual({ ok: true });
    const next = await start(); const nextJob = await claim();
    for (let seconds = 60; seconds < 600; seconds += 60) await runWorkerAction(db, { action: "heartbeat", jobId: next, leaseToken: nextJob.leaseToken, workerId: "aw-worker" }, new Date(now.getTime() + seconds * 1000));
    await expect(runWorkerAction(db, { action: "complete", jobId: next, leaseToken: nextJob.leaseToken, result: result() }, new Date(now.getTime() + 600000))).rejects.toMatchObject({ status: 409 });
  });
  it("cancellation invalidates heartbeat and late completion without retrying", async () => {
    const id = await start(); const job = await claim();
    await runWorkbenchAction(db, user, site, { action: "cancel", jobId: id }, now);
    for (const action of [{ action: "heartbeat", workerId: "aw-worker" }, { action: "complete", result: result() }]) await expect(runWorkerAction(db, { ...action, jobId: id, leaseToken: job.leaseToken }, now)).rejects.toMatchObject({ status: 409 });
    expect(await runWorkerAction(db, { action: "claim", workerId: "aw-worker" }, now)).toEqual({ job: null });
  });
  it("saves only owner drafts with optimistic concurrency and preserves original generated output", async () => {
    const job = await finish(); const request = { action: "saveDraft", jobId: job.id, expectedUpdatedAt: job.updatedAt.toISOString(), draftText: "My reviewed text" };
    await expect(runWorkbenchAction(db, "aw-other", "aw-other-site", request, now)).rejects.toMatchObject({ status: 404 });
    await runWorkbenchAction(db, user, site, request, now);
    await expect(runWorkbenchAction(db, user, site, { ...request, draftText: "stale overwrite" }, now)).rejects.toMatchObject({ status: 409 });
    const saved = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: job.id } }); expect(saved.draftText).toBe("My reviewed text"); expect(saved.result).toEqual(result());
    await expect(runWorkerAction(db, { action: "complete", jobId: job.id, leaseToken: "old", result: result() }, now)).rejects.toMatchObject({ status: 409 });
    const view = await getWorkbenchWorkspace(db, user, site, now); expect(JSON.stringify(view)).not.toMatch(/leaseToken|Never share this foreign|aw-foreign-page/);
  });
  it("fails schema-invalid results instead of storing them", async () => {
    const id = await start(); const job = await claim();
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: job.leaseToken, result: { ...result(), executed: true } }, now)).rejects.toThrow();
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).draftText).toBeNull();
  });
  it("starts paragraph review from the original body, preserving the full proposal and observed usage", async () => {
    const body = "This original paragraph explains an observed feature and its practical limits. A second sentence gives enough context for review without inventing claims.";
    const id = await start({ ...input, kind: "REWRITE_ARTICLE", pageId: "aw-page", body });
    const job = await claim();
    const proposed = { ...result(), paragraphEdits: [{ id: "p1", sourceText: body, replacementText: "A clearer proposed explanation.", reason: "Improve clarity", evidence: ["Pasted original paragraph"], verification: ["Owner should verify the feature"] }] };
    const usage = { source: "CODEX_CLI", inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: null, totalTokens: 120 };
    await runWorkerAction(db, { action: "complete", jobId: id, leaseToken: job.leaseToken, result: proposed, usage }, now);
    const saved = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(saved.draftText).toBe(body); expect(saved.result).toEqual(proposed); expect(saved.usage).toEqual(usage);
    const action = { action: "saveDraft", jobId: id, expectedUpdatedAt: saved.updatedAt.toISOString(), draftText: "Owner accepted replacement" };
    await runWorkbenchAction(db, user, site, action, now);
    await expect(runWorkbenchAction(db, user, site, action, now)).rejects.toMatchObject({ status: 409 });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } })).result).toEqual(proposed);
  });
  it.each(["WRITE_ARTICLE", "SEO_FIX_PLAN"])("rejects paragraph edits in %s completions before storing a draft", async kind => {
    const body = "This source paragraph is unique and grounded in the saved article. It includes enough explanatory context for a targeted revision.";
    const id = await start({ ...input, kind, pageId: "aw-page", body });
    const job = await claim();
    const proposed = { ...result(), paragraphEdits: [{ id: "p1", sourceText: body, replacementText: "A proposed revision.", reason: "Clarity", evidence: ["Source paragraph"], verification: ["Review the proposal"] }] };
    await expect(runWorkerAction(db, { action: "complete", jobId: id, leaseToken: job.leaseToken, result: proposed }, now)).rejects.toThrow("only supported for rewrite tasks");
    const saved = await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id } });
    expect(saved.result).toBeNull(); expect(saved.draftText).toBeNull(); expect(saved.status).toBe("RUNNING");
  });
});
describe("all generated links require local evidence", () => {
  const context = { allowedInternalLinks: [url] };
  it("accepts evidence URLs and relative markdown forms", () => {
    expect(validateWorkbenchResult({ ...result(), contentMarkdown: "[Guide](/guide) and [Guide](https://workbench.example/guide)" }, "workbench.example", context).title).toBe("A useful guide");
  });
  it.each(["https://outside.example/steal", "[link](/invented)", "[link](javascript:alert(1))", "[ref]: https://outside.example/steal", '<a href="https://outside.example/steal">link</a>', "<https://outside.example/steal>"])("rejects URL bypass in %s", contentMarkdown => {
    expect(() => validateWorkbenchResult({ ...result(), contentMarkdown }, "workbench.example", context)).toThrow("verified site URLs");
  });
});
