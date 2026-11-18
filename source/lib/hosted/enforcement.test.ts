import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { authenticateHostedDevice, createHostedSession, revokeHostedSessions, withHostedWorker } from "./session";
import { hostedSession, hostedSiteAllows, hostedAccountDecision, currentHostedPolicy, currentHostedFeatureAllowed } from "./access";
import { controlCall } from "./control";
import { runWorkerAction } from "@/lib/content-planner/worker";
import { getWorkbenchWorkspace, runWorkbenchAction } from "@/lib/ai-workbench/data";
import { desktopOrigin } from "@/lib/desktop/oauth";
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ db: null as PrismaClient | null, cookieToken: "", googleFetch: vi.fn() }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(mocks) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookieToken ? { value: mocks.cookieToken } : undefined }) }));
vi.mock("@/lib/google/google-fetch", () => ({ googleFetch: mocks.googleFetch }));
import { proxy } from "@/proxy";
import { GET as readSessionStatus } from "@/app/api/hosted/session/route";
import { handleGoogleConnection, completeGoogleConnection, GOOGLE_CONNECTION_CALLBACK, GSC_CONNECTION_SCOPE } from "@/lib/google/connection";
import { openGoogleTokens } from "@/lib/google/token-store";
import { contentReceiptStatus } from "./receipts";

describe("hosted device and tenant enforcement", () => {
  let fixture: TestDb;
  let available = true;
  let maintenance = false;
  const devices = new Map<string, { accountId: string; token: string; binding: string; allowed: boolean }>();
  const calls: { action: string; body: Record<string, string> }[] = [];
  const issuer = "https://control.example.test";
  const headers = (id: string) => new Headers({ authorization: `Bearer ${devices.get(id)!.token}`,
    "x-aborder-installation-id": id, "x-aborder-product-id": "a-border-seo", "x-aborder-desktop-version": "1.5.0" });
  const input = (id: string) => ({ productId: "a-border-seo", installationId: id, desktopVersion: "1.5.0" });
  const connect = (id: string) => authenticateHostedDevice(fixture.db, headers(id), input(id));
  const worker = (id: string, action: object) => withHostedWorker(fixture.db,
    new Request("https://workspace.example.test/api/local-content-worker", { headers: headers(id) }), action,
    () => runWorkerAction(fixture.db, action));
  beforeAll(async () => { fixture = await createTestDb(); mocks.db = fixture.db; }, 120000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.db.user.deleteMany(); await fixture.db.contentWorkerState.deleteMany();
    vi.stubEnv("ABORDER_HOSTED", "1");
    vi.stubEnv("ABORDER_CONTROL_INTERNAL_SECRET", "fixture-only-internal-secret-32-characters");
    vi.stubEnv("NEXTAUTH_SECRET", "fixture-only-encryption-secret");
    mocks.cookieToken = ""; mocks.googleFetch.mockReset();
    devices.clear(); calls.length = 0; available = true; maintenance = false;
    for (const [id, accountId] of [["a1", "a"], ["a2", "a"], ["b1", "b"]]) devices.set(id, {
      accountId, token: `fixture-device-token-${id}-long-enough`, binding: `fixture-binding-${id}`, allowed: true,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init: RequestInit) => {
      if (!available) throw new Error("fixture unavailable");
      const action = new URL(url).pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init.body)); calls.push({ action, body });
      if (action === "receipt") return Response.json({ ok: true });
      const device = devices.get(body.installationId);
      if (action !== "account-policy" && (!device || (action === "authenticate" ? body.deviceToken !== device.token : body.sessionBinding !== device.binding))) {
        return Response.json({ error: "device_authentication_failed" }, { status: 401 });
      }
      const now = Math.floor(Date.now() / 1000);
      const enabled = action === "account-policy" ? [...devices.values()].some(d => d.accountId === body.accountId && d.allowed) : device!.allowed;
      const allowed = enabled && !maintenance;
      return Response.json({ v: 1, scope: action === "account-policy" ? "account" : "device", issuer,
        productId: "a-border-seo", accountId: device?.accountId ?? body.accountId, installationId: body.installationId ?? null,
        username: "fixture", label: "Fixture account", checkedAt: now, validUntil: now + 30, revision: 1,
        allowed, reason: !enabled ? "device_disabled" : maintenance ? "maintenance" : null, features: { jobs: allowed, codex: allowed, manus: allowed, geo: allowed },
        maintenanceMessage: maintenance ? "Scheduled database maintenance" : "", release: null, receiptTicket: "fixture-ticket", ...(action === "authenticate" ? { sessionBinding: device!.binding } : {}) });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("preserves migrated account data and isolates two accounts despite identical labels", async () => {
    const user = await fixture.db.user.create({ data: { email: "migrated@example.test", googleTokens: { encryptedFixture: true } } });
    await fixture.db.managedIdentity.create({ data: { issuer, productId: "a-border-seo", accountId: "a", userId: user.id } });
    const a = await connect("a1"); const b = await connect("b1");
    expect(a.device.userId).toBe(user.id); expect(b.device.userId).not.toBe(user.id);
    expect((await fixture.db.user.findUniqueOrThrow({ where: { id: user.id } })).googleTokens).toEqual({ encryptedFixture: true });
    const site = await fixture.db.site.create({ data: { userId: user.id, domain: "tenant-a.example.test" } });
    expect(await hostedSiteAllows(fixture.db, site.id, "jobs", b.device.id)).toBe(false);
    expect(await hostedSiteAllows(fixture.db, site.id, "jobs", a.device.id)).toBe(true);
    await expect(authenticateHostedDevice(fixture.db, headers("a1"), { ...input("a1"), accountId: "b" })).rejects.toMatchObject({ status: 401 });
  });

  it("rechecks every cookie use and invalidates the old session after token rotation", async () => {
    const session = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    expect(await hostedSession(fixture.db, session.sessionToken)).not.toBeNull();
    expect(await hostedSession(fixture.db, session.sessionToken)).not.toBeNull();
    expect(calls.filter(c => c.action === "device-policy")).toHaveLength(2);
    devices.get("a1")!.binding = "rotated-binding";
    expect(await hostedSession(fixture.db, session.sessionToken)).toBeNull();
    const replacement = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    expect(await hostedSession(fixture.db, session.sessionToken)).toBeNull();
    expect(await hostedSession(fixture.db, replacement.sessionToken)).not.toBeNull();
    devices.get("a1")!.allowed = false;
    expect(await hostedSession(fixture.db, replacement.sessionToken)).toBeNull();
  });

  it("revokes only this device's sessions even when disabled and never creates an identity during logout", async () => {
    const a = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    const a2 = await createHostedSession(fixture.db, headers("a2"), input("a2"));
    const b = await createHostedSession(fixture.db, headers("b1"), input("b1"));
    await expect(revokeHostedSessions(fixture.db, headers("a1"), input("a2"))).rejects.toMatchObject({ status: 401 });
    expect(await fixture.db.session.count()).toBe(3);
    devices.get("a1")!.allowed = false;
    expect(await revokeHostedSessions(fixture.db, headers("a1"), input("a1"))).toEqual({ ok: true });
    expect(await fixture.db.session.count()).toBe(2);
    devices.get("a1")!.allowed = true;
    expect(await hostedSession(fixture.db, a.sessionToken)).toBeNull();
    expect(await hostedSession(fixture.db, a2.sessionToken)).not.toBeNull();
    expect(await hostedSession(fixture.db, b.sessionToken)).not.toBeNull();
    maintenance = true;
    expect(await revokeHostedSessions(fixture.db, headers("a2"), input("a2"))).toEqual({ ok: true });
    expect(await hostedSession(fixture.db, a2.sessionToken)).toBeNull();
    devices.set("unknown", { accountId: "new-account", token: "fixture-not-registered-device-token", binding: "fixture-new", allowed: false });
    const counts = { users: await fixture.db.user.count(), devices: await fixture.db.hostedDevice.count() };
    expect(await revokeHostedSessions(fixture.db, headers("unknown"), input("unknown"))).toEqual({ ok: true });
    expect({ users: await fixture.db.user.count(), devices: await fixture.db.hostedDevice.count() }).toEqual(counts);
    available = false;
    await expect(revokeHostedSessions(fixture.db, headers("b1"), input("b1"))).rejects.toMatchObject({ status: 503 });
    expect(await fixture.db.session.count()).toBe(1);
  });

  it("fails closed when control service is unavailable without an offline server grant", async () => {
    const a = await connect("a1");
    const session = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    available = false;
    expect(await hostedSession(fixture.db, session.sessionToken)).toBeNull();
    expect(await hostedAccountDecision(fixture.db, a.device.userId)).toBeNull();
    await expect(connect("a1")).rejects.toMatchObject({ status: 503 });
    await expect(controlCall("account-policy", { accountId: "a", productId: "a-border-seo" })).rejects.toThrow("hosted_verification_unavailable");
  });

  it("isolates claims and lease actions by device, including devices of one account", async () => {
    const a = await connect("a1"); await connect("a2"); const b = await connect("b1");
    const site = await fixture.db.site.create({ data: { userId: a.device.userId, domain: "tenant-a.example.test" } });
    const otherSite = await fixture.db.site.create({ data: { userId: b.device.userId, domain: "tenant-b.example.test" } });
    await fixture.db.aiWorkbenchJob.createMany({ data: [
      { id: "aw_a", siteId: site.id, hostedDeviceId: a.device.id, kind: "WRITE_ARTICLE", title: "A", request: { kind: "WRITE_ARTICLE", title: "A", provider: "CHATGPT_APP" }, context: { evidence: "tenant-a" } },
      { id: "aw_b", siteId: otherSite.id, kind: "WRITE_ARTICLE", title: "B", request: { kind: "WRITE_ARTICLE", title: "B" }, context: { evidence: "tenant-b-private" } },
    ] });
    const claim = { action: "claim", workerId: "ignored-shared-id", protocolVersion: 2, metadata: { codexLogin: true, desktopVersion: "1.5.0" } };
    expect(await worker("a2", claim)).toMatchObject({ job: null });
    const claimed = await worker("a1", claim);
    if (!("job" in claimed) || !claimed.job) throw new Error("Expected fixture job");
    expect(claimed.job).toMatchObject({ jobId: "aw_a", provider: "CODEX_LOCAL" });
    expect(claimed.job.prompt).toContain("tenant-a"); expect(claimed.job.prompt).not.toContain("tenant-b-private");
    const heartbeat = { action: "heartbeat", workerId: "ignored", jobId: "aw_a", leaseToken: claimed.job.leaseToken };
    await expect(worker("a2", heartbeat)).rejects.toMatchObject({ status: 409 });
    await expect(worker("b1", heartbeat)).rejects.toMatchObject({ status: 409 });
    expect(await worker("a1", heartbeat)).toMatchObject({ ok: true });
    devices.get("a1")!.allowed = false;
    await expect(worker("a1", heartbeat)).rejects.toMatchObject({ status: 403 });
    expect(calls.filter(call => call.action === "receipt").at(-1)?.body).toMatchObject({ component: "content_worker", status: "draining" });
    expect(await fixture.db.aiWorkbenchJob.findUnique({ where: { id: "aw_a" } })).toMatchObject({ status: "RUNNING" });
    expect(await fixture.db.contentWorkerState.findUnique({ where: { id: "ignored-shared-id" } })).toBeNull();
  });

  it("does not accept shared worker credentials or claim while local Codex is signed out", async () => {
    await expect(authenticateHostedDevice(fixture.db, new Headers({ authorization: "Bearer old-shared-secret-32-characters" }), input("a1"))).rejects.toMatchObject({ status: 401 });
    expect(await worker("a1", { action: "claim", workerId: "x", protocolVersion: 2, metadata: { codexLogin: false, desktopVersion: "1.5.0" } })).toMatchObject({ job: null });
  });

  it.each(["KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] as const)("executes %s on the signed-in device using a bounded evidence sample", async kind => {
    const { db } = fixture;
    const { device } = await connect("a1");
    mocks.cookieToken = (await createHostedSession(db, headers("a1"), input("a1"))).sessionToken;
    const site = await db.site.create({ data: { userId: device.userId, domain: "research.example.com" } });
    const crawl = await db.crawl.create({ data: { siteId: site.id, status: "COMPLETED", finishedAt: new Date() } });
    await db.auditPage.createMany({ data: Array.from({ length: 40 }, (_, i) => ({
      crawlId: crawl.id, url: `https://research.example.com/${i}-${"a".repeat(1730)}`, statusCode: 200, indexable: true, title: "Seed topic",
    })) });
    const settings = kind === "KEYWORD_RESEARCH" ? { keyword: "Seed", keywordResearch: { count: 12, targetMarket: "US" } } : { researchAnalysis: { targetMarket: "US" } };
    const start = { action: "start", kind, provider: "CODEX_LOCAL", title: "Seed", ...settings };
    const claim = { action: "claim", workerId: "local", protocolVersion: 2, metadata: { codexLogin: true, desktopVersion: "1.5.4" } };
    await expect(runWorkbenchAction(db, device.userId, site.id, start)).rejects.toMatchObject({ status: 409 });
    await worker("a1", { action: "heartbeat", workerId: "local", metadata: claim.metadata });
    await expect(runWorkbenchAction(db, device.userId, site.id, { ...start, provider: "CHATGPT_APP" })).rejects.toMatchObject({ status: 409 });
    const response = await runWorkbenchAction(db, device.userId, site.id, start);
    if (!("jobId" in response)) throw new Error("Expected a queued job");
    expect(await worker("a2", claim)).toMatchObject({ job: null });
    const claimed = await worker("a1", claim);
    if (!("job" in claimed) || !claimed.job) throw new Error("Expected device-bound work");
    expect(claimed.job).toMatchObject({ jobId: response.jobId, provider: "CODEX_LOCAL" });
    expect(JSON.stringify(claimed).length).toBeLessThanOrEqual(65536);
    expect(claimed.job.prompt).toContain(kind === "KEYWORD_RESEARCH" ? "reducedToFitWorker" : "Worker input size limited");
    expect(claimed.job.prompt).toContain("Seed topic");
    expect(JSON.stringify(claimed.job.outputSchema)).not.toContain('"$ref"');
    const result = { title: "Research", summary: "Observed sample", contentMarkdown: "Review the saved sample.", metaTitle: "", metaDescription: "",
      changeNotes: [], factChecks: ["Check the source"], internalLinks: [], paragraphEdits: [],
      ...(kind === "KEYWORD_RESEARCH" ? { keywordIdeas: [{ keyword: "Seed question", intent: "INFORMATIONAL", funnel: "TOFU", cluster: "Seed", angle: "Answer the question", rationale: "From the seed" }] } : {}) };
    const lease = { jobId: response.jobId, leaseToken: claimed.job.leaseToken };
    expect(await worker("a1", { action: "begin", ...lease })).toMatchObject({ allowed: true });
    const usage = { source: "CODEX_CLI", inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const completion = { action: "complete", ...lease, result, usage };
    await expect(worker("a2", completion)).rejects.toMatchObject({ status: 409 });
    await expect(worker("a1", { ...completion, result: { ...result, metaTitle: "Article metadata" } })).rejects.toThrow();
    expect(await worker("a1", completion)).toMatchObject({ ok: true });
    expect((await db.aiWorkbenchJob.findUniqueOrThrow({ where: { id: response.jobId } })).usage).toMatchObject(usage);
    const view = await getWorkbenchWorkspace(db, device.userId, site.id, new Date(), kind);
    expect(view.jobs[0]).toMatchObject({ id: response.jobId, status: "SUCCEEDED", result });
    expect(await db.savedKeyword.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("permits a maintenance read session but pauses claims and lets an existing device lease drain", async () => {
    const a = await connect("a1");
    const site = await fixture.db.site.create({ data: { userId: a.device.userId, domain: "maintenance.example.test" } });
    const now = new Date();
    await fixture.db.aiWorkbenchJob.create({ data: { id: "aw_drain", siteId: site.id, hostedDeviceId: a.device.id,
      kind: "WRITE_ARTICLE", title: "Drain", request: {}, context: {}, status: "RUNNING", leaseToken: "fixture-lease",
      startedAt: now, leaseExpiresAt: new Date(now.getTime() + 120000) } });
    maintenance = true;
    const session = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    expect(calls.filter(call => call.action === "receipt").at(-1)?.body).toMatchObject({ component: "http_session", status: "blocked" });
    expect((await hostedSession(fixture.db, session.sessionToken))?.snapshot).toMatchObject({ allowed: false, reason: "maintenance" });
    expect(await worker("a1", { action: "claim", workerId: "x", protocolVersion: 2, metadata: { codexLogin: true, desktopVersion: "1.5.0" } })).toMatchObject({ job: null });
    expect(calls.filter(call => call.action === "receipt").at(-1)?.body).toMatchObject({ component: "content_worker", status: "draining" });
    expect(await worker("a1", { action: "heartbeat", workerId: "x", jobId: "aw_drain", leaseToken: "fixture-lease" })).toMatchObject({ ok: true });
    expect(await worker("a1", { action: "fail", jobId: "aw_drain", leaseToken: "fixture-lease", error: "Fixture stopped for maintenance" })).toMatchObject({ ok: true });
    expect(calls.filter(call => call.action === "receipt").at(-1)?.body).toMatchObject({ component: "content_worker", status: "blocked" });
    expect(await fixture.db.aiWorkbenchJob.findUnique({ where: { id: "aw_drain" } })).toMatchObject({ status: "FAILED" });
  });

  it("counts only affected valid leases of the reporting device and its account", async () => {
    const a = await connect("a1"); const a2 = await connect("a2"); const b = await connect("b1");
    const site = await fixture.db.site.create({ data: { userId: a.device.userId, domain: "receipt-a.example.test" } });
    const foreign = await fixture.db.site.create({ data: { userId: b.device.userId, domain: "receipt-b.example.test" } });
    const pillar = await fixture.db.contentPillar.create({ data: { siteId: site.id, title: "Fixture", keyword: "fixture" } });
    const now = new Date(); const valid = { startedAt: now, leaseExpiresAt: new Date(now.getTime() + 120000), leaseToken: "fixture-lease", status: "RUNNING" as const };
    await fixture.db.contentPlanJob.create({ data: { id: "receipt-plan", siteId: site.id, pillarId: pillar.id, hostedDeviceId: a.device.id, ...valid } });
    const base = { kind: "WRITE_ARTICLE", title: "Fixture", request: {}, context: {}, ...valid };
    await fixture.db.aiWorkbenchJob.createMany({ data: [
      { id: "aw_other_device", siteId: site.id, hostedDeviceId: a2.device.id, ...base },
      { id: "aw_foreign_owner", siteId: foreign.id, hostedDeviceId: a.device.id, ...base },
    ] });
    const restricted = { ...a.snapshot, features: { ...a.snapshot.features, codex: false } };
    expect(await contentReceiptStatus(fixture.db, restricted, a.device, now)).toBe("draining");
    await fixture.db.contentPlanJob.update({ where: { id: "receipt-plan" }, data: { leaseExpiresAt: now } });
    expect(await contentReceiptStatus(fixture.db, restricted, a.device, now)).toBe("blocked");
    await fixture.db.aiWorkbenchJob.create({ data: { id: "aw_own_device", siteId: site.id, hostedDeviceId: a.device.id, ...base } });
    expect(await contentReceiptStatus(fixture.db, restricted, a.device, now)).toBe("draining");
    expect(await contentReceiptStatus(fixture.db, a.snapshot, a.device, now)).toBe("effective");
    await fixture.db.aiWorkbenchJob.update({ where: { id: "aw_own_device" }, data: { startedAt: new Date(now.getTime() - 600000) } });
    expect(await contentReceiptStatus(fixture.db, restricted, a.device, now)).toBe("blocked");
    const broken = { contentPlanJob: { count: async () => { throw new Error("fixture unavailable"); } }, aiWorkbenchJob: { count: async () => 0 } } as unknown as PrismaClient;
    expect(await contentReceiptStatus(broken, restricted, a.device, now)).toBe("failed");
  });

  it("uses the configured HTTPS workspace origin independently of control-plane issuer", () => {
    vi.stubEnv("ABORDER_WORKSPACE_ORIGIN", "https://new-workspace.example.test");
    expect(desktopOrigin()).toBe("https://new-workspace.example.test");
    vi.stubEnv("ABORDER_WORKSPACE_ORIGIN", "http://new-workspace.example.test"); expect(desktopOrigin()).toBeNull();
    vi.stubEnv("ABORDER_WORKSPACE_ORIGIN", "https://new-workspace.example.test/other"); expect(desktopOrigin()).toBeNull();
  });

  it("enforces cookie policy in the HTTP proxy, preserving maintenance reads only", async () => {
    const session = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    const request = (method = "GET", token = session.sessionToken) => new NextRequest("https://workspace.example.test/api/sites", {
      method, headers: { cookie: `__Secure-authjs.session-token=${token}` },
    });
    expect((await proxy(request())).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("GET", "invalid"))).status).toBe(401);
    available = false;
    expect((await proxy(request())).status).toBe(503);
    available = true;
    maintenance = true;
    mocks.cookieToken = session.sessionToken;
    expect(await currentHostedPolicy()).toMatchObject({ allowed: false, reason: "maintenance", maintenanceMessage: "Scheduled database maintenance" });
    expect(await (await readSessionStatus()).json()).toEqual({ maintenance: true, message: "Scheduled database maintenance" });
    expect(await currentHostedFeatureAllowed("jobs")).toBe(false);
    expect((await proxy(request())).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("POST"))).status).toBe(503);
    expect(calls.at(-1)?.body).toMatchObject({ component: "http_api", status: "blocked", code: "maintenance" });
    maintenance = false; devices.get("a1")!.allowed = false;
    const denied = await proxy(request());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "device_disabled" });
    expect(calls.at(-1)?.body).toMatchObject({ component: "http_api", status: "blocked", code: "device_disabled" });
    const page = new NextRequest("https://workspace.example.test/sites", { headers: request().headers });
    expect((await proxy(page)).headers.get("location")).toBe("https://workspace.example.test/managed-status");
    expect(await currentHostedPolicy()).toMatchObject({ allowed: false, reason: "device_disabled" });
    expect((await readSessionStatus()).status).toBe(403);
    expect(await hostedSession(fixture.db, session.sessionToken)).toBeNull();
    devices.get("a1")!.allowed = true;
    expect((await proxy(request())).headers.get("x-middleware-next")).toBe("1");
    expect(await (await readSessionStatus()).json()).toEqual({ maintenance: false, message: "" });
    devices.get("a1")!.binding = "revoked";
    expect((await proxy(page)).headers.get("location")).toBe("https://workspace.example.test/login");
    expect(await currentHostedPolicy()).toBeNull();
    expect((await readSessionStatus()).status).toBe(401);
  });

  it("binds cloud Google consent to the initiating device and HTTPS callback without changing account", async () => {
    const origin = "https://workspace.example.test";
    vi.stubEnv("ABORDER_WORKSPACE_ORIGIN", origin);
    vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret");
    const a = await connect("a1");
    const session = await createHostedSession(fixture.db, headers("a1"), input("a1"));
    const second = await createHostedSession(fixture.db, headers("a2"), input("a2"));
    mocks.cookieToken = session.sessionToken;
    const verifier = "a".repeat(43); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const started = await handleGoogleConnection({ action: "start", challenge }, a.device.userId, origin);
    if (typeof started.id !== "string" || typeof started.url !== "string") throw new Error("Expected consent transaction");
    expect(new URL(started.url).searchParams.get("redirect_uri")).toBe(origin + GOOGLE_CONNECTION_CALLBACK);
    mocks.cookieToken = "";
    expect(await completeGoogleConnection(started.id, "fixture-google-code", origin, origin + GOOGLE_CONNECTION_CALLBACK)).toBe(true);
    mocks.cookieToken = second.sessionToken;
    await expect(handleGoogleConnection({ action: "claim", id: started.id, verifier }, a.device.userId, origin)).rejects.toMatchObject({ status: 403 });
    expect(mocks.googleFetch).not.toHaveBeenCalled();
    mocks.cookieToken = session.sessionToken;
    mocks.googleFetch.mockResolvedValue(Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh",
      expires_in: 3600, token_type: "Bearer", scope: GSC_CONNECTION_SCOPE }));
    expect(await handleGoogleConnection({ action: "claim", id: started.id, verifier }, a.device.userId, origin)).toEqual({ connected: true });
    const user = await fixture.db.user.findUniqueOrThrow({ where: { id: a.device.userId } });
    expect(openGoogleTokens(user.googleTokens)?.refreshToken).toBe("fixture-refresh");
    expect(await fixture.db.user.count()).toBe(1);
    const again = await handleGoogleConnection({ action: "start", challenge }, a.device.userId, origin);
    if (typeof again.id !== "string") throw new Error("Expected consent transaction");
    devices.get("a1")!.binding = "rotated-google-binding";
    await expect(completeGoogleConnection(again.id, "fixture-google-code", origin, origin + GOOGLE_CONNECTION_CALLBACK)).rejects.toMatchObject({ status: 401 });
  });
});
