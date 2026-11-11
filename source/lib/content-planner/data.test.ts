import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { expireContentJobs, getContentWorkspace, LEASE_MS, runContentAction } from "./data";
import { runWorkerAction } from "./worker";
import { examplePlan } from "./test-fixtures";

let testDb: TestDb;
let db: PrismaClient;
const siteId = "content-site";
const userId = "content-owner";
let pillarId: string;

beforeAll(async () => {
  testDb = await createTestDb(); db = testDb.db;
  await db.user.createMany({ data: [{ id: userId, email: "owner@catalog.example" }, { id: "other-owner", email: "other@catalog.example" }] });
  await db.site.createMany({ data: [{ id: siteId, userId, domain: "ssad.shop" }, { id: "other-site", userId: "other-owner", domain: "other.example" }] });
}, 120_000);
afterAll(async () => { await testDb?.close(); });
beforeEach(async () => {
  await db.contentPillar.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.page.deleteMany(); await db.crawl.deleteMany();
  const created = await db.contentPillar.create({ data: { siteId, title: "Useful guides", keyword: "cup" } });
  pillarId = created.id;
});
async function start(now = new Date()) {
  return runContentAction(db, userId, siteId, { action: "startPlan", pillarId, topicCount: 3 }, now);
}
async function claim(now = new Date()) {
  const response = await runWorkerAction(db, { action: "claim", workerId: "test-worker" }, now);
  if (!("job" in response) || !response.job) throw new Error("Expected a claimed job");
  return response.job;
}
async function finish(now = new Date()) {
  await start(now); const job = await claim(now);
  await runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: examplePlan() }, now);
  return job;
}

describe("content ownership and imports", () => {
  it("isolates workspaces and prevents foreign pillar, cluster and job mutations", async () => {
    await expect(getContentWorkspace(db, "other-owner", siteId)).rejects.toMatchObject({ status: 404 });
    await expect(getContentWorkspace(db, "", siteId)).rejects.toMatchObject({ status: 401 });
    const foreign = await db.contentPillar.create({ data: { siteId: "other-site", title: "Foreign", keyword: "foreign" } });
    const foreignCluster = await db.contentCluster.create({ data: { siteId: "other-site", pillarId: foreign.id, title: "Foreign topic", keyword: "foreign", dedupeKey: "foreign", funnel: "TOFU" } });
    const foreignJob = await db.contentPlanJob.create({ data: { siteId: "other-site", pillarId: foreign.id, status: "SUCCEEDED", result: examplePlan() as Prisma.InputJsonValue } });
    for (const action of [
      { action: "updatePillar", pillarId: foreign.id, data: { title: "Changed" } },
      { action: "createCluster", pillarId: foreign.id, data: { title: "Bad", keyword: "bad", funnel: "TOFU" } },
      { action: "startPlan", pillarId: foreign.id, topicCount: 3, funnelCounts: { TOFU: 0, MOFU: 1, BOFU: 2 } },
      { action: "deleteCluster", clusterId: foreignCluster.id },
      { action: "applyPlan", jobId: foreignJob.id, topicIndexes: [0] },
    ]) await expect(runContentAction(db, userId, siteId, action)).rejects.toMatchObject({ status: 404 });
    expect((await db.contentPillar.findUniqueOrThrow({ where: { id: foreign.id } })).title).toBe("Foreign");
  });

  it("imports only selected topics, skips existing keywords, and never applies the same plan twice", async () => {
    await runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: { title: "Existing coverage", keyword: "CUP QUESTION 0", funnel: "TOFU" } });
    const original = await db.contentCluster.findFirstOrThrow({ where: { pillarId } });
    const job = await finish();
    expect(await runContentAction(db, userId, siteId, { action: "applyPlan", jobId: job.jobId, topicIndexes: [0, 1, 1] })).toMatchObject({ imported: 1, updated: 0 });
    expect(await runContentAction(db, userId, siteId, { action: "applyPlan", jobId: job.jobId, topicIndexes: [2], updateExistingBriefs: true })).toMatchObject({ imported: 0, updated: 0, alreadyApplied: true });
    const rows = await db.contentCluster.findMany({ where: { pillarId }, orderBy: { keyword: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.source === "AI")).toMatchObject({ keyword: "cup question 1", status: "BRIEF_READY" });
    expect(rows.some((row) => row.keyword === "cup question 2")).toBe(false);
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  it("updates an existing brief only with explicit opt-in while preserving editorial fields and avoiding duplicate rows", async () => {
    const manualBrief = { ...examplePlan().topics[0].brief, summary: "Original editorial summary" };
    await runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: {
      title: "An editor's existing title", keyword: "CUP QUESTION 0", funnel: "BOFU", intent: "Existing intent",
      contentType: "Checklist", status: "PUBLISHED", url: "https://ssad.shop/article/existing",
      scheduledFor: "2026-11-15T08:00:00.000Z", brief: manualBrief,
    } });
    const original = await db.contentCluster.findFirstOrThrow({ where: { pillarId } });
    const otherPillar = await db.contentPillar.create({ data: { siteId, title: "Another pillar", keyword: "other" } });
    const untouched = await db.contentCluster.create({ data: {
      siteId, pillarId: otherPillar.id, title: "Other pillar topic", keyword: "cup question 0", dedupeKey: "cup question 0",
      funnel: "TOFU", brief: manualBrief as Prisma.InputJsonValue,
    } });
    const job = await finish();
    const appliedAt = new Date(Date.now() + 1000);
    const action = { action: "applyPlan", jobId: job.jobId, topicIndexes: [0, 1], updateExistingBriefs: true };
    expect(await runContentAction(db, userId, siteId, action, appliedAt)).toMatchObject({ imported: 1, updated: 1, alreadyApplied: false });
    const updated = await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } });
    expect(updated).toEqual({ ...original, brief: examplePlan().topics[0].brief, source: "AI", updatedAt: appliedAt });
    expect(await db.contentCluster.count({ where: { pillarId } })).toBe(2);
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: untouched.id } })).toEqual(untouched);
    expect(await runContentAction(db, userId, siteId, action)).toMatchObject({ imported: 0, updated: 0, alreadyApplied: true });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } })).toEqual(updated);
  });

  it("rolls back prior brief updates and the apply marker if another selected brief is invalid", async () => {
    const manualBrief = { ...examplePlan().topics[0].brief, summary: "Keep this manual brief" };
    await runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: {
      title: "Original", keyword: "cup question 0", funnel: "TOFU", brief: manualBrief,
    } });
    const original = await db.contentCluster.findFirstOrThrow({ where: { pillarId } });
    const plan = examplePlan();
    plan.topics[1].brief.internalLinks = [{ target: "https://outside.example/invalid", title: "Invalid", reason: "Foreign origin" }];
    const job = await db.contentPlanJob.create({ data: { siteId, pillarId, status: "SUCCEEDED", result: plan as Prisma.InputJsonValue } });
    await expect(runContentAction(db, userId, siteId, {
      action: "applyPlan", jobId: job.id, topicIndexes: [0, 1], updateExistingBriefs: true,
    })).rejects.toMatchObject({ status: 400 });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await db.contentCluster.count({ where: { pillarId } })).toBe(1);
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: job.id } })).appliedAt).toBeNull();
  });

  it("rejects invalid selections without consuming the ready plan", async () => {
    const job = await finish();
    await expect(runContentAction(db, userId, siteId, { action: "applyPlan", jobId: job.jobId, topicIndexes: [17] })).rejects.toMatchObject({ status: 400 });
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: job.jobId } })).appliedAt).toBeNull();
  });

  it("rejects foreign mapping URLs and foreign links inside a manual brief", async () => {
    await expect(runContentAction(db, userId, siteId, { action: "updatePillar", pillarId, data: { url: "https://outside.example/page" } })).rejects.toMatchObject({ status: 400 });
    const brief = examplePlan().topics[0].brief;
    brief.internalLinks = [{ target: "https://outside.example/page", title: "Foreign", reason: "Unsupported" }];
    await expect(runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: { title: "Invalid brief", keyword: "invalid", funnel: "TOFU", brief } })).rejects.toMatchObject({ status: 400 });
    expect(await db.contentCluster.count()).toBe(0);
  });

  it("seeds three clearly marked reusable examples idempotently for the owned demo site", async () => {
    expect(await runContentAction(db, userId, siteId, { action: "seedExample" })).toMatchObject({ imported: 3 });
    expect(await runContentAction(db, userId, siteId, { action: "seedExample" })).toMatchObject({ imported: 0 });
    const rows = await db.contentCluster.findMany();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === "EXAMPLE")).toBe(true);
    expect(rows.filter((row) => row.url)).toHaveLength(2);
    await expect(runContentAction(db, "other-owner", "other-site", { action: "seedExample" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("local worker leases", () => {
  it("rejects an invalid allocation before queueing any generation", async () => {
    await expect(runContentAction(db, userId, siteId, { action: "startPlan", pillarId, topicCount: 3, funnelCounts: { TOFU: 3, MOFU: 1, BOFU: 0 } })).rejects.toThrow(/Funnel counts/);
    expect(await db.contentPlanJob.count()).toBe(0);
  });

  it("persists an unequal mix, enforces it at completion and imports only after acceptance", async () => {
    const funnelCounts = { TOFU: 2, MOFU: 0, BOFU: 1 };
    await runContentAction(db, userId, siteId, { action: "startPlan", pillarId, topicCount: 3, funnelCounts });
    const job = await claim();
    expect(job.prompt).toContain("TOFU 2, MOFU 0, BOFU 1");
    const stored = await db.contentPlanJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(stored.request).toEqual({ funnelCounts });
    expect(stored.context).toMatchObject({ funnelCounts });
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: examplePlan() })).rejects.toMatchObject({ status: 400, message: "Generated topics do not match this task's funnel distribution" });
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: job.jobId } })).status).toBe("RUNNING");
    const result = examplePlan(); result.topics[1].funnel = "TOFU";
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result })).resolves.toEqual({ ok: true });
    expect(await db.contentCluster.count()).toBe(0);
    expect((await getContentWorkspace(db, userId, siteId)).jobs[0]).toMatchObject({ topicCount: 3, funnelCounts });
    await expect(runContentAction(db, userId, siteId, { action: "applyPlan", jobId: job.jobId, topicIndexes: [0, 1, 2] })).resolves.toMatchObject({ imported: 3 });
    expect(await db.contentCluster.count({ where: { funnel: "MOFU" } })).toBe(0);
  });

  it("keeps the balanced completion contract for pre-upgrade queued jobs without request JSON", async () => {
    await db.contentPlanJob.create({ data: { siteId, pillarId, topicCount: 3, activeKey: siteId } });
    const job = await claim();
    expect(job.prompt).toContain("TOFU 1, MOFU 1, BOFU 1");
    const wrong = examplePlan(); wrong.topics[1].funnel = "TOFU";
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: wrong })).rejects.toMatchObject({ status: 400 });
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: examplePlan() })).resolves.toEqual({ ok: true });
  });

  it("permits only one active job per site and only one worker claim", async () => {
    const starts = await Promise.allSettled([start(), start()]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claims = await Promise.all([
      runWorkerAction(db, { action: "claim", workerId: "worker-a" }),
      runWorkerAction(db, { action: "claim", workerId: "worker-b" }),
    ]);
    expect(claims.filter((result) => "job" in result && result.job)).toHaveLength(1);
    await expect(runContentAction(db, userId, siteId, { action: "deletePillar", pillarId })).rejects.toMatchObject({ status: 409 });
    const workspace = await getContentWorkspace(db, userId, siteId);
    expect(workspace.worker.online).toBe(true);
    expect(JSON.stringify(workspace.jobs)).not.toContain("leaseToken");
    expect(JSON.stringify(workspace.jobs)).not.toContain("activeKey");
  });

  it("rejects stolen or expired leases and makes expired jobs ineligible for import", async () => {
    const now = new Date(); await start(now); const job = await claim(now);
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: "wrong-token", result: examplePlan() }, now)).rejects.toMatchObject({ status: 409 });
    const expired = new Date(now.getTime() + LEASE_MS + 1);
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: examplePlan() }, expired)).rejects.toMatchObject({ status: 409 });
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: job.jobId } })).status).toBe("FAILED");
    await expect(runContentAction(db, userId, siteId, { action: "applyPlan", jobId: job.jobId, topicIndexes: [0] }, expired)).rejects.toMatchObject({ status: 409 });
    expect(await db.contentCluster.count()).toBe(0);
    await expect(start(expired)).resolves.toMatchObject({ ok: true });
  });

  it("extends a valid lease and validates AI URLs before accepting the result", async () => {
    const now = new Date(); await start(now); const job = await claim(now);
    const heartbeatAt = new Date(now.getTime() + 60_000);
    await runWorkerAction(db, { action: "heartbeat", workerId: "test-worker", jobId: job.jobId, leaseToken: job.leaseToken }, heartbeatAt);
    const plan = examplePlan(); plan.topics[0].brief.internalLinks = [{ target: "https://outside.example", title: "Bad", reason: "Foreign" }];
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: plan }, heartbeatAt)).rejects.toMatchObject({ status: 400 });
    plan.topics[0].brief.internalLinks[0].target = "https://ssad.shop/invented-page";
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: plan }, heartbeatAt)).rejects.toMatchObject({ status: 400 });
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: examplePlan() }, new Date(now.getTime() + 150_000))).resolves.toEqual({ ok: true });
    expect(await db.contentCluster.count()).toBe(0);
  });

  it("accepts links from the persisted prompt evidence and does not expose that context in the workspace", async () => {
    const target = "https://ssad.shop/article/observed";
    await db.page.create({ data: { siteId, url: target, date: new Date("2026-10-21"), clicks: 2, impressions: 10, position: 3 } });
    await start(); const job = await claim();
    expect(job.prompt).toContain(target);
    const plan = examplePlan(); plan.topics[0].brief.internalLinks = [{ target, title: "Observed guide", reason: "Relevant supporting page" }];
    await expect(runWorkerAction(db, { action: "complete", jobId: job.jobId, leaseToken: job.leaseToken, result: plan })).resolves.toEqual({ ok: true });
    const workspace = await getContentWorkspace(db, userId, siteId);
    expect(workspace.jobs[0]).not.toHaveProperty("context");
  });

  it("times out an abandoned queue without automatically importing or retrying it", async () => {
    await start();
    const old = new Date(Date.now() - 31 * 60_000);
    await db.contentPlanJob.updateMany({ data: { createdAt: old } });
    await expireContentJobs(db);
    const row = await db.contentPlanJob.findFirstOrThrow();
    expect(row).toMatchObject({ status: "FAILED", activeKey: null, appliedAt: null });
    expect(await runWorkerAction(db, { action: "claim", workerId: "test-worker" })).toEqual({ job: null });
  });
});

describe("real mapped URL evidence", () => {
  it("uses a 28-day window ending at latest GSC data, weighted rank, nullable unknowns and sampled link evidence", async () => {
    const pillarUrl = "https://ssad.shop/article/pillar";
    const topicUrl = "https://ssad.shop/article/topic";
    await runContentAction(db, userId, siteId, { action: "updatePillar", pillarId, data: { url: pillarUrl } });
    await runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: { title: "Mapped topic", keyword: "mapped", funnel: "MOFU", url: topicUrl } });
    await runContentAction(db, userId, siteId, { action: "createCluster", pillarId, data: { title: "Unknown topic", keyword: "unknown", funnel: "BOFU" } });
    await db.page.createMany({ data: [
      { siteId, url: topicUrl, date: new Date("2026-10-20"), clicks: 2, impressions: 10, position: 2 },
      { siteId, url: topicUrl, date: new Date("2026-10-21"), clicks: 3, impressions: 30, position: 6 },
      { siteId, url: topicUrl, date: new Date("2026-08-01"), clicks: 999, impressions: 999, position: 1 },
      { siteId: "other-site", url: topicUrl, date: new Date("2026-10-21"), clicks: 999, impressions: 999, position: 1 },
    ] });
    await db.crawl.create({ data: { id: "content-evidence-crawl", siteId, status: "COMPLETED", pagesFound: 200, maxPages: 200, finishedAt: new Date("2026-11-04T08:00:00Z") } });
    await db.auditPage.create({ data: { crawlId: "content-evidence-crawl", url: pillarUrl, statusCode: 200 } });
    await db.auditLink.create({ data: { crawlId: "content-evidence-crawl", sourceUrl: pillarUrl, targetUrl: topicUrl, isInternal: true } });
    const workspace = await getContentWorkspace(db, userId, siteId);
    expect(workspace.metricsPeriod).toEqual({ startDate: "2026-09-24", endDate: "2026-10-21" });
    const mapped = workspace.pillars[0].clusters.find((topic) => topic.keyword === "mapped")!;
    expect(mapped.performance).toMatchObject({ clicks: 5, impressions: 40, ctr: 0.125, position: 5 });
    expect(mapped.searchVolume).toBeNull();
    expect(mapped.linkEvidence).toMatchObject({ sampleLimited: true, pillarToCluster: true, clusterToPillar: false, sourceInSample: true, targetInSample: false });
    expect(workspace.pillars[0].performance).toBeNull();
    expect(workspace.pillars[0].clusters.find((topic) => topic.keyword === "unknown")!.performance).toBeNull();
  });
});
