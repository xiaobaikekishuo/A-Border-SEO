import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ db: null as PrismaClient | null, device: "device-a" as string | null,
  deniedSites: new Set<string>(), deniedDevices: new Set<string>(), denyGeo: false }));
vi.mock("@/lib/hosted/access", () => ({
  hostedMode: () => true,
  currentHostedDevice: async () => fixture.device ? { id: fixture.device } : null,
  hostedSiteAllows: async (_db: unknown, siteId: string, feature: string, deviceId?: string | null) =>
    !fixture.deniedSites.has(siteId) && !(deviceId && fixture.deniedDevices.has(deviceId))
    && !(feature === "geo" && fixture.denyGeo) && (!deviceId || deviceId === `device-${siteId.slice(-1)}`),
}));
vi.mock("@/lib/managed/identity", () => ({ managedUserScope: async () => ({ managed: false, userId: null }) }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(fixture) };
});
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { registerJobHandler } from "./handlers";
import { claimJobById, claimJobs, enqueueJob } from "./queue";
import { JobRunner } from "./runner";
import { registerSchedule, runScheduler } from "./scheduler";
import { scheduleConfig } from "./config";

let testDb: TestDb, db: PrismaClient;
const type = "hosted-fixture";
const run = vi.fn(async () => undefined);
registerJobHandler({ type, class: "SHORT", maxAttempts: 2, isPermanent: () => false, run });
registerJobHandler({ type: "geo-hosted-fixture", class: "SHORT", maxAttempts: 2, isPermanent: () => false, run });
beforeAll(async () => {
  testDb = await createTestDb(); db = fixture.db = testDb.db;
  for (const suffix of ["a", "b"]) {
    await db.user.create({ data: { id: `hosted-user-${suffix}`, email: `hosted-${suffix}@fixture.example` } });
    await db.site.create({ data: { id: `hosted-site-${suffix}`, userId: `hosted-user-${suffix}`, domain: `${suffix}.fixture.example` } });
  }
}, 120_000);
afterAll(async () => { await testDb?.close(); });
beforeEach(async () => {
  fixture.device = "device-a"; fixture.deniedSites.clear(); fixture.deniedDevices.clear(); fixture.denyGeo = false;
  run.mockClear(); await db.job.deleteMany(); await db.schedulerState.deleteMany();
});
async function queued(siteId: string, deviceId: string | null = null, priority = 0, jobType = type) {
  return db.job.create({ data: { type: jobType, siteId, source: "manual", hostedDeviceId: deviceId,
    priority, runAt: new Date(0), maxAttempts: 2 } });
}

it("derives manual provenance from the verified session and rejects foreign sites or missing sessions", async () => {
  const own = await enqueueJob(db, { type, siteId: "hosted-site-a", source: "manual", hostedDeviceId: "device-b" });
  expect(own.job.hostedDeviceId).toBe("device-a");
  await expect(enqueueJob(db, { type, siteId: "hosted-site-b", source: "manual" })).rejects.toMatchObject({ code: "HOSTED_POLICY_RESTRICTED" });
  fixture.device = null;
  await expect(enqueueJob(db, { type, siteId: "hosted-site-a", source: "manual" })).rejects.toMatchObject({ code: "HOSTED_SESSION_REQUIRED" });
});

it("keeps revoked-device jobs queued without consuming attempts while allowing independent account schedules", async () => {
  fixture.deniedDevices.add("device-a");
  const blocked = await queued("hosted-site-a", "device-a", 100);
  const scheduled = await queued("hosted-site-a");
  expect(await claimJobById(db, { workerId: "hosted", jobId: blocked.id })).toBeNull();
  expect((await claimJobs(db, { workerId: "hosted", types: [type], limit: 1 })).map(job => job.id)).toEqual([scheduled.id]);
  expect(await db.job.findUniqueOrThrow({ where: { id: blocked.id } })).toMatchObject({ status: "QUEUED", attempts: 0 });
});

it("does not let a full page of disabled accounts starve another account", async () => {
  fixture.deniedSites.add("hosted-site-a");
  await db.job.createMany({ data: Array.from({ length: 51 }, () => ({ type, siteId: "hosted-site-a", source: "schedule", priority: 100, runAt: new Date(0), maxAttempts: 2 })) });
  const allowed = await queued("hosted-site-b");
  expect((await claimJobs(db, { workerId: "hosted", types: [type], limit: 1 })).map(job => job.id)).toEqual([allowed.id]);
});

it("applies feature restrictions before claiming and runs the preserved job after recovery", async () => {
  fixture.denyGeo = true;
  const job = await queued("hosted-site-a", null, 0, "geo-hosted-fixture");
  expect(await claimJobById(db, { workerId: "hosted", jobId: job.id })).toBeNull();
  fixture.denyGeo = false;
  expect((await claimJobById(db, { workerId: "hosted", jobId: job.id }))?.id).toBe(job.id);
});

it("schedules only allowed accounts and leaves schedules independent of browser sessions", async () => {
  fixture.device = null; fixture.deniedSites.add("hosted-site-a");
  const unregister = registerSchedule({ type, intervalMs: 1, isDue: () => true });
  try {
    await runScheduler(db, { config: scheduleConfig({}), types: [type], force: true });
    expect(await db.job.findMany({ select: { siteId: true, hostedDeviceId: true } })).toEqual([{ siteId: "hosted-site-b", hostedDeviceId: null }]);
  } finally { unregister(); }
});

it("rechecks policy after claim and releases without running a newly disabled account", async () => {
  const record = await queued("hosted-site-a", "device-a");
  const job = await claimJobById(db, { workerId: "hosted", jobId: record.id });
  fixture.deniedSites.add("hosted-site-a");
  expect((await new JobRunner(db, { workerId: "hosted", log: () => {} }).execute(job!)).outcome).toBe("released");
  expect(run).not.toHaveBeenCalled();
});

it("aborts in-flight work after the originating device is disabled", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const longType = "hosted-running-fixture";
  registerJobHandler({ type: longType, class: "LONG", maxAttempts: 2, isPermanent: () => false,
    run: ({ signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); began(); }) });
  const record = await queued("hosted-site-a", "device-a", 0, longType);
  const job = await claimJobById(db, { workerId: "hosted", jobId: record.id });
  const runner = new JobRunner(db, { workerId: "hosted", log: () => {} });
  const running = runner.execute(job!); await started;
  fixture.deniedDevices.add("device-a"); await runner.heartbeat();
  expect((await running).outcome).toBe("released");
  expect(await db.job.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ status: "QUEUED", attempts: 0 });
});

it("preserves the device on follow-up jobs", async () => {
  const parentType = "hosted-parent-fixture";
  registerJobHandler({ type: parentType, class: "SHORT", maxAttempts: 2, isPermanent: () => false, run,
    followUps: () => [type] });
  const record = await queued("hosted-site-a", "device-a", 0, parentType);
  const job = await claimJobById(db, { workerId: "hosted", jobId: record.id });
  const result = await new JobRunner(db, { workerId: "hosted", log: () => {} }).execute(job!);
  expect(result.followUps).toHaveLength(1);
  expect(result.followUps[0]).toMatchObject({ source: "chain", hostedDeviceId: "device-a" });
});
