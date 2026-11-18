import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ scope: { managed: true, userId: "owner-a" as string | null }, db: null as PrismaClient | null }));
vi.mock("@/lib/managed/identity", () => ({ managedUserScope: async () => ({ ...fixture.scope }) }));
vi.mock("@/lib/managed/policy", () => ({
  managedAllows: () => true, managedAllowsJob: () => true,
  managedDecision: () => ({ enabled: fixture.scope.managed, allowed: true, features: { jobs: true, codex: true, manus: true, geo: true } }),
}));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(fixture) };
});
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { enqueueJob, claimJobs, claimJobById } from "./queue";
import { registerJobHandler } from "./handlers";
import { registerSchedule, runScheduler } from "./scheduler";
import { scheduleConfig } from "./config";
import { JobRunner } from "./runner";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { claimWorkbenchJob } from "@/lib/ai-workbench/worker";

let testDb: TestDb, db: PrismaClient;
const run = vi.fn(async () => undefined);
const type = "managed-owner-fixture";
registerJobHandler({ type, class: "SHORT", maxAttempts: 2, isPermanent: () => false, run });
beforeAll(async () => {
  testDb = await createTestDb(); db = fixture.db = testDb.db;
  for (const suffix of ["a", "b"]) {
    await db.user.create({ data: { id: `owner-${suffix}`, email: `owner-${suffix}@fixture.example` } });
    await db.site.create({ data: { id: `site-${suffix}`, userId: `owner-${suffix}`, domain: `${suffix}.fixture.example` } });
  }
}, 120_000);
afterAll(async () => { await testDb?.close(); });
beforeEach(async () => {
  fixture.scope = { managed: true, userId: "owner-a" };
  run.mockClear();
  await db.job.deleteMany(); await db.aiWorkbenchJob.deleteMany(); await db.schedulerState.deleteMany();
  await db.contentPlanJob.deleteMany(); await db.contentPillar.deleteMany();
});
async function queued(siteId: string, priority = 0) {
  return db.job.create({ data: { type, siteId, source: "manual", priority, runAt: new Date(0), maxAttempts: 2 } });
}
it("filters owner in SQL before LIMIT, denies foreign by-id claim and enqueue, preserves unmanaged access", async () => {
  const foreign = await queued("site-b", 100);
  const own = await queued("site-a");
  expect((await claimJobs(db, { workerId: "fixture", types: [type], limit: 1 })).map(row => row.id)).toEqual([own.id]);
  expect(await claimJobById(db, { workerId: "fixture", jobId: foreign.id })).toBeNull();
  await expect(enqueueJob(db, { type, siteId: "site-b", source: "manual" })).rejects.toMatchObject({ code: "MANAGED_OWNER_RESTRICTED" });
  fixture.scope.managed = false;
  expect((await claimJobById(db, { workerId: "fixture", jobId: foreign.id }))?.id).toBe(foreign.id);
});
it("fails closed with no mapped owner and releases a foreign claimed job before handler execution", async () => {
  const foreign = await queued("site-b");
  fixture.scope = { managed: true, userId: null };
  expect(await claimJobs(db, { workerId: "fixture", types: [type], limit: 1 })).toEqual([]);
  fixture.scope.managed = false;
  const claimed = await claimJobById(db, { workerId: "fixture", jobId: foreign.id });
  fixture.scope = { managed: true, userId: "owner-a" };
  expect((await new JobRunner(db, { workerId: "fixture" }).execute(claimed!)).outcome).toBe("released");
  expect(run).not.toHaveBeenCalled();
  expect((await db.job.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("QUEUED");
});
it("schedules only sites owned by the active account", async () => {
  const unregister = registerSchedule({ type, intervalMs: 1, isDue: () => true });
  try {
    await runScheduler(db, { config: scheduleConfig({}), types: [type], force: true });
    expect((await db.job.findMany()).map(row => row.siteId)).toEqual(["site-a"]);
  } finally { unregister(); }
});
it("filters Codex/ChatGPT claims and denies begin after owner changes without expiring preserved foreign work", async () => {
  const now = new Date();
  const request = { kind: "WRITE_ARTICLE", title: "Fixture", language: "en", instructions: "Draft", keyword: "fixture" };
  await db.contentPillar.create({ data: { id: "foreign-pillar", siteId: "site-b", title: "Foreign pillar", keyword: "fixture" } });
  await db.contentPlanJob.create({ data: { id: "foreign-plan", siteId: "site-b", pillarId: "foreign-pillar",
    createdAt: new Date(now.getTime() - 50 * 60_000) } });
  await db.aiWorkbenchJob.create({ data: { id: "aw_foreign", siteId: "site-b", kind: "WRITE_ARTICLE", title: "Foreign",
    request, context: {}, createdAt: new Date(now.getTime() - 40 * 60_000) } });
  await db.aiWorkbenchJob.create({ data: { id: "aw_own", siteId: "site-a", kind: "WRITE_ARTICLE", title: "Own", request, context: {}, createdAt: now } });
  expect(await claimWorkbenchJob(db, "aw_foreign", now)).toEqual({ job: null });
  const result = await runWorkerAction(db, { action: "claim", workerId: "fixture", protocolVersion: 2 }, now);
  expect(result).toMatchObject({ job: { jobId: "aw_own" } });
  expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_foreign" } })).status).toBe("QUEUED");
  expect((await db.contentPlanJob.findUniqueOrThrow({ where: { id: "foreign-plan" } })).status).toBe("QUEUED");
  const job = "job" in result ? result.job : null;
  expect(job).toBeTruthy();
  fixture.scope = { managed: true, userId: "owner-b" };
  expect(await runWorkerAction(db, { action: "begin", jobId: job!.jobId, leaseToken: job!.leaseToken }, now)).toEqual({ ok: true, allowed: false });
  expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: "aw_own" } })).status).toBe("QUEUED");
});

it("ordinary running work receives an abort and releases its lease when the managed owner changes", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const longType = "managed-owner-long-fixture";
  registerJobHandler({ type: longType, class: "LONG", maxAttempts: 2, isPermanent: () => false,
    run: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      began();
    }) });
  const queuedJob = await db.job.create({ data: { type: longType, siteId: "site-a", source: "manual", runAt: new Date(0), maxAttempts: 2 } });
    const job = await claimJobById(db, { workerId: "owner-runner", jobId: queuedJob.id });
    const runner = new JobRunner(db, { workerId: "owner-runner", log: () => {} });
    const running = runner.execute(job!);
    await started;
    fixture.scope.userId = "owner-b";
    await runner.heartbeat();
    expect((await running).outcome).toBe("released");
    expect((await db.job.findUniqueOrThrow({ where: { id: queuedJob.id } })).status).toBe("QUEUED");
});
