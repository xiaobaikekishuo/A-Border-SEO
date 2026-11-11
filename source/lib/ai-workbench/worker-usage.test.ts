import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { examplePlan } from "@/lib/content-planner/test-fixtures";

let database: TestDb; let db: PrismaClient;
const now = new Date("2026-11-06T06:00:00Z");
const leaseToken = "worker_usage_fixture_lease";
const usage = { source: "CODEX_CLI", inputTokens: 120, cachedInputTokens: 80, outputTokens: 30, reasoningTokens: null, totalTokens: 150 };
const result = { title: "Draft", summary: "Review draft", contentMarkdown: "# Draft\nReview before publishing.", metaTitle: "Draft", metaDescription: "Draft description", changeNotes: [], factChecks: ["Review before publishing"], internalLinks: [] };
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.create({ data: { id: "usage-worker-owner", email: "usage-worker@example.test" } });
  await db.site.create({ data: { id: "usage-worker-site", userId: "usage-worker-owner", domain: "ssad.shop" } });
  await db.contentPillar.create({ data: { id: "usage-worker-pillar", siteId: "usage-worker-site", title: "Guides", keyword: "guides" } });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.aiWorkbenchJob.deleteMany(); await db.contentPlanJob.deleteMany();
  const lease = { status: "RUNNING" as const, leaseToken, startedAt: now, leaseExpiresAt: new Date(now.getTime() + 120000) };
  await db.aiWorkbenchJob.create({ data: { id: "aw_usage", siteId: "usage-worker-site", kind: "WRITE_ARTICLE", title: "Draft", request: { provider: "CODEX_LOCAL", kind: "WRITE_ARTICLE", title: "Draft" }, context: { allowedInternalLinks: [] }, ...lease } });
  await db.contentPlanJob.create({ data: { id: "plan_usage", siteId: "usage-worker-site", pillarId: "usage-worker-pillar", topicCount: 3, context: { allowedInternalLinks: [] }, ...lease } });
});
describe("trusted CLI usage reports", () => {
  it.each(["workbench", "planner"])("stores %s usage once with completion and never counts cache twice", async kind => {
    const workbench = kind === "workbench", jobId = workbench ? "aw_usage" : "plan_usage";
    const action = { action: "complete", jobId, leaseToken, result: workbench ? result : examplePlan(), usage };
    await expect(runWorkerAction(db, action, now)).resolves.toEqual({ ok: true });
    const row = workbench ? await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: jobId } }) : await db.contentPlanJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "SUCCEEDED", usage });
    expect(row.result).not.toHaveProperty("usage");
    await expect(runWorkerAction(db, action, now)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["aw_usage", "plan_usage"])("keeps known usage on failed %s tasks after output validation rejects the draft", async jobId => {
    await expect(runWorkerAction(db, { action: "complete", jobId, leaseToken, result: { usage, fabricated: true }, usage }, now)).rejects.toThrow();
    await runWorkerAction(db, { action: "fail", jobId, leaseToken, error: "invalid_model_output", usage }, now);
    const row = jobId.startsWith("aw_") ? await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: jobId } }) : await db.contentPlanJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "FAILED", usage, result: null });
  });
  it("keeps unknown reports null, including older helpers without a usage field", async () => {
    await runWorkerAction(db, { action: "complete", jobId: "aw_usage", leaseToken, result }, now);
    await runWorkerAction(db, { action: "fail", jobId: "plan_usage", leaseToken, error: "no_usage_event", usage: null }, now);
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_usage" } })).usage).toBeNull();
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: "plan_usage" } })).usage).toBeNull();
  });
  it("rejects fabricated model-body usage and invalid host counters before mutation", async () => {
    await expect(runWorkerAction(db, { action: "complete", jobId: "aw_usage", leaseToken, result: { ...result, usage } }, now)).rejects.toThrow();
    for (const invalid of [
      { ...usage, inputTokens: -1 }, { ...usage, outputTokens: 0.5 }, { ...usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...usage, totalTokens: 230 }, { ...usage, cachedInputTokens: 121 }, { ...usage, reasoningTokens: 31 },
      { ...usage, source: "CHATGPT_RESPONSE" },
    ]) await expect(runWorkerAction(db, { action: "fail", jobId: "aw_usage", leaseToken, error: "fixture", usage: invalid }, now)).rejects.toThrow();
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_usage" } })).usage).toBeNull();
  });
  it("does not attribute CLI counters to an independent app job", async () => {
    await db.aiWorkbenchJob.update({ where: { id: "aw_usage" }, data: { request: { provider: "CHATGPT_APP", kind: "WRITE_ARTICLE", title: "Draft" } } });
    await expect(runWorkerAction(db, { action: "fail", jobId: "aw_usage", leaseToken, error: "fixture", usage }, now)).rejects.toMatchObject({ status: 409 });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_usage" } })).usage).toBeNull();
  });
  it("preserves cancellation and lease isolation for late usage", async () => {
    await db.aiWorkbenchJob.update({ where: { id: "aw_usage" }, data: { status: "FAILED", leaseToken: null, leaseExpiresAt: null, error: "canceled" } });
    for (const action of [
      { action: "fail", jobId: "aw_usage", leaseToken, error: "late", usage },
      { action: "fail", jobId: "plan_usage", leaseToken: "wrong_lease", error: "stolen", usage },
    ]) await expect(runWorkerAction(db, action, now)).rejects.toMatchObject({ status: 409 });
    await expect(runWorkerAction(db, { action: "fail", jobId: "plan_usage", leaseToken, error: "expired", usage }, new Date(now.getTime() + 121000))).rejects.toMatchObject({ status: 409 });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_usage" } })).usage).toBeNull();
    expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: "plan_usage" } })).usage).toBeNull();
  });
});
