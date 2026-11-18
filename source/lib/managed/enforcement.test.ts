import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { claimJobs } from "@/lib/jobs/queue";
import { runScheduler } from "@/lib/jobs/scheduler";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { APP_VERSION } from "@/lib/version";
import { proxy } from "@/proxy";
import { managedHealth } from "./health";
import { decisionFingerprint, managedDecision } from "./policy";
import { audience, signLease, type LeasePolicy } from "./protocol.mjs";

const keys = generateKeyPairSync("ed25519");
const issuer = "https://management.example.test";
const config = {
  serverUrl: issuer, issuer, productId: "a-border-seo",
  keys: { current: keys.publicKey.export({ format: "pem", type: "spki" }) },
};
const request = (path: string, method = "GET") => new NextRequest(`http://localhost:3300${path}`, { method });
const unpaused: LeasePolicy = {
  productDisabled: false, accountDisabled: false, deviceDisabled: false, entitlementExpiresAt: null,
  maintenance: { active: false, message: "" }, features: { jobs: true, codex: true, manus: true, geo: true },
  minimumDesktopVersion: null, minimumBackendVersion: null, release: null,
};

describe("managed business enforcement", () => {
  let directory: string;
  let fixture: TestDb;
  let sequence: number;

  beforeAll(async () => { fixture = await createTestDb(); });
  afterAll(async () => { await fixture.close(); });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aborder-managed-"));
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
    vi.stubEnv("ABORDER_MANAGED", "1");
    vi.stubEnv("ABORDER_MANAGED_POLICY_DIR", directory);
    sequence = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(join(directory, "config.json"), { force: true });
    rmSync(join(directory, "state.json"), { force: true });
    rmdirSync(directory);
  });

  function apply(policy: Partial<LeasePolicy> = {}, lifetime = 300) {
    const now = Math.floor(Date.now() / 1000);
    const installationId = "installation-test";
    const accountId = "account-test";
    const lease = signLease({
      v: 1, iss: issuer, aud: audience, productId: config.productId, installationId, accountId,
      iat: now - 60, exp: now - 60 + lifetime, sequence: ++sequence, revision: sequence,
      policy: { ...unpaused, ...policy },
    }, "current", keys.privateKey);
    writeFileSync(join(directory, "state.json"), JSON.stringify({
      v: 1, installationId, accountId, lease, desktopVersion: APP_VERSION, receivedAt: now, highestWallTime: now,
    }));
  }

  it("guards browser and direct business routes without disabling recovery", async () => {
    expect((await proxy(request("/api/sites"))).status).toBe(403);
    apply({ accountDisabled: true, maintenance: { active: true, message: "Maintenance" } });
    expect(await (await proxy(request("/api/sites"))).json()).toEqual({ error: "account_disabled" });
    expect((await proxy(request("/sites"))).headers.get("location")).toBe("http://localhost:3300/managed-status");
    expect((await proxy(request("/api/v1/sites"))).status).toBe(403);
    expect((await proxy(request("/mcp", "POST"))).status).toBe(403);
    expect((await proxy(request("/api/health"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/sites/sample/export"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/desktop/oauth", "POST"))).headers.get("x-middleware-next")).toBe("1");

    apply({ maintenance: { active: true, message: "Maintenance" } });
    expect((await proxy(request("/api/sites"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/sites", "POST"))).status).toBe(503);
    expect((await proxy(request("/api/cron/tick"))).status).toBe(503);
    expect((await proxy(request("/mcp", "POST"))).headers.get("x-middleware-next")).toBe("1");

    apply({ minimumBackendVersion: "999.0.0" });
    expect(await (await proxy(request("/api/sites"))).json()).toEqual({ error: "update_required" });
    apply({}, 30);
    expect(await (await proxy(request("/api/sites"))).json()).toEqual({ error: "lease_expired" });
    apply();
    expect((await proxy(request("/api/sites", "POST"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("blocks ordinary and host claims, keeps leases finishable, and reports worker convergence", async () => {
    const { db } = fixture;
    const user = await db.user.create({ data: { email: "managed-fixture@example.test" } });
    await db.managedIdentity.create({ data: {
      issuer, productId: config.productId, accountId: "account-test", userId: user.id,
    } });
    const site = await db.site.create({ data: { userId: user.id, domain: "managed-fixture.example.test" } });
    const now = new Date();
    const job = await db.job.create({ data: { siteId: site.id, type: "gsc-sync", source: "manual", maxAttempts: 1 } });
    const jobId = "aw_managed-fixture";
    const leaseToken = randomUUID();
    await db.aiWorkbenchJob.create({ data: {
      id: jobId, siteId: site.id, kind: "ARTICLE_WRITE", title: "Isolated job",
      status: "RUNNING", request: {}, context: {}, startedAt: now,
      leaseToken, leaseExpiresAt: new Date(now.getTime() + 120_000),
    } });

    apply({ deviceDisabled: true });
    expect(await claimJobs(db, { workerId: "normal", types: ["gsc-sync"], limit: 1 })).toEqual([]);
    expect((await runScheduler(db, { force: true })).ran).toBe(false);
    expect(await runWorkerAction(db, { action: "claim", workerId: "host", protocolVersion: 2 })).toEqual({ managedProtocol: 2, job: null });
    expect(await managedHealth(db)).toMatchObject({ phase: "pending", appApplied: true, workerApplied: false });

    await db.workerHeartbeat.create({ data: {
      id: "normal", mode: "worker", hostname: "fixture", version: APP_VERSION,
      startedAt: now, lastSeenAt: now, managedPolicy: decisionFingerprint(),
    } });
    expect(await managedHealth(db)).toMatchObject({ phase: "draining", workerApplied: true, activeJobs: 1 });
    expect(await runWorkerAction(db, { action: "heartbeat", workerId: "host", jobId, leaseToken })).toMatchObject({ ok: true });
    expect(await runWorkerAction(db, { action: "begin", jobId, leaseToken })).toEqual({ ok: true, allowed: false });
    expect(await db.aiWorkbenchJob.findUnique({ where: { id: jobId } })).toMatchObject({ status: "QUEUED", leaseToken: null });
    expect(await managedHealth(db)).toMatchObject({ phase: "effective", workerApplied: true, activeJobs: 0 });
    expect((await db.job.findUnique({ where: { id: job.id } }))?.status).toBe("QUEUED");

    apply();
    expect(await managedHealth(db)).toMatchObject({ phase: "pending", workerApplied: false });
    expect(await runWorkerAction(db, { action: "claim", workerId: "older-host" })).toEqual({ managedProtocol: 2, job: null });
    expect(await claimJobs(db, { workerId: "normal", types: ["gsc-sync"], limit: 1 })).toMatchObject([{ id: job.id, status: "RUNNING" }]);
    expect(managedDecision()).toMatchObject({ allowed: true, reason: null });
  });
});
