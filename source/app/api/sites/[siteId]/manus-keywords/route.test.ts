import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { decrypt } from "@/lib/encryption";
import { ManusError } from "@/lib/manus/types";

const state = vi.hoisted(() => ({
  db: null as PrismaClient | null, userId: "owner", create: vi.fn(), read: vi.fn(), check: vi.fn(), download: vi.fn(), report: vi.fn(), parse: vi.fn(),
}));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(state) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: state.userId } }) }));
vi.mock("@/lib/manus/client", async (original) => ({
  ...await original<typeof import("@/lib/manus/client")>(),
  createResearch: state.create, readResearch: state.read, checkKey: state.check, downloadResearchWorkbook: state.download, downloadResearchReport: state.report,
}));
vi.mock("@/lib/manus/keyword-workbook", async (original) => ({
  ...await original<typeof import("@/lib/manus/keyword-workbook")>(), parseKeywordWorkbook: state.parse,
}));

import { GET, POST } from "./route";
import { POST as refresh } from "./[taskId]/refresh/route";
import { GET as cachedPreview, POST as loadWorkbook } from "./[taskId]/candidates/route";
import { POST as saveSelection } from "./[taskId]/save/route";
import { GET as fullReport } from "./[taskId]/report/route";
import { POST as saveKey, GET as keyStatus, DELETE as removeKey } from "@/app/api/user/api-keys/route";
import { POST as checkKey } from "@/app/api/user/api-keys/test/route";

let testDb: TestDb;
let db: PrismaClient;
const base = "http://localhost/api/sites/home/manus-keywords";
const input = { seeds: ["keyword research"], language: "en", audience: "" };
const context = (siteId = "home") => ({ params: Promise.resolve({ siteId }) });
function request(data: object, origin = "http://localhost", method = "POST") {
  return new Request(base, { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
}
function submit(data: object, siteId = "home") {
  return POST(request({ ...input, confirmed: true, requestId: randomUUID(), ...data }), context(siteId));
}
function update(id: string, siteId = "home", origin = "http://localhost") {
  return refresh(request({}, origin), { params: Promise.resolve({ siteId, taskId: id }) });
}
const list = (siteId = "home") => GET(new Request(base), context(siteId));
const setKey = (apiKey: string) => saveKey(request({ provider: "manus", apiKey }));

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-only-manus-secret");
  testDb = await createTestDb();
  db = state.db = testDb.db;
  for (const [id, siteId] of [["owner", "home"], ["other", "away"]]) {
    await db.user.create({ data: { id, email: id + "@example.test" } });
    await db.site.create({ data: { id: siteId, domain: "example.test", userId: id } });
  }
}, 120_000);
afterAll(async () => { await testDb?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  state.userId = "owner";
  await db.manusKeywordTask.deleteMany();
  await db.savedKeyword.deleteMany();
  await db.apiKey.deleteMany();
  state.create.mockReset().mockResolvedValue({ remoteId: "remote", taskUrl: "https://manus.im/app/remote" });
  state.read.mockReset().mockResolvedValue({
    status: "completed", summary: "Research summary", files: [{ name: "sheet.xlsx", url: "https://example.test/file" }],
    taskUrl: "https://manus.im/app/remote",
  });
  state.check.mockReset().mockResolvedValue(undefined);
  state.download.mockReset().mockResolvedValue({ filename: "research.xlsx", bytes: Buffer.from("mock workbook") });
  state.report.mockReset().mockResolvedValue({ filename: "research.md", text: "# Full report" });
  state.parse.mockReset().mockReturnValue([{ keyword: "测试", alternateKeyword: "Example keyword" }, { keyword: "Other idea" }]);
  expect((await setKey("owner-placeholder")).status).toBe(201);
});

describe("Manus keys and keyword tasks", () => {
  it("previews an existing workbook and saves only selected terms, including an English alternate", async () => {
    const task = await db.manusKeywordTask.create({ data: { userId: "owner", siteId: "home", remoteId: "existing-remote", input, requestId: randomUUID(), status: "completed" } });
    const ctx = { params: Promise.resolve({ siteId: "home", taskId: task.id }) };
    const blank = () => new Request(base, { method: "POST", headers: { origin: "http://localhost", "content-length": "0" }, body: new Uint8Array(0) });
    const peek = () => cachedPreview(new Request(base), ctx);
    expect(await (await peek()).json()).toMatchObject({ revision: 0, rows: [] });
    const first = await (await loadWorkbook(blank(), ctx)).json();
    expect(first).toMatchObject({ revision: 1, source: "manus", saved: [], rows: [{ keyword: "测试" }, { keyword: "Other idea" }] });
    expect(state.download).toHaveBeenCalledExactlyOnceWith("owner-placeholder", "existing-remote");
    expect(state.report).not.toHaveBeenCalled();
    expect(await (await fullReport(new Request(base),ctx)).json()).toEqual({ filename: "research.md", text: "# Full report" });
    expect(state.create).not.toHaveBeenCalled();
    expect(await db.savedKeyword.count()).toBe(0);
    const select = (keywords: string[], revision = 1) => saveSelection(request({ keywords, revision }), ctx);
    expect((await select(["extra"])).status).toBe(400);
    expect(await (await select(["example KEYWORD"])).json()).toEqual({ added: 1, skipped: 0 });
    expect(await (await select(["Example keyword"])).json()).toEqual({ added: 0, skipped: 1 });
    expect(await (await peek()).json()).toMatchObject({ saved: ["Example keyword"] });
    expect(await db.savedKeyword.findMany({select:{query:true}})).toEqual([{query:"Example keyword"}]);
    const upload = new Request(base, { method: "POST", headers: { "content-type": "application/octet-stream","x-workbook-name": "manual.xlsx" }, body: "mock bytes" });
    await db.apiKey.deleteMany();
    expect(await (await loadWorkbook(upload,ctx)).json()).toMatchObject({ revision: 2, source: "upload", filename: "manual.xlsx" });
    expect((await select(["Other idea"])).status).toBe(409);
    expect(state.download).toHaveBeenCalledOnce();
    state.userId = "other";
    expect((await peek()).status).toBe(404);
    expect((await fullReport(new Request(base),ctx)).status).toBe(404);
    expect(state.report).toHaveBeenCalledOnce();
    expect((await select(["Other idea"], 2)).status).toBe(404);
  });

  it("requires same-origin writes and rejects oversized uploads without altering a saved preview", async () => {
    const task = await db.manusKeywordTask.create({ data: { userId: "owner", siteId: "home", remoteId: "remote", input, requestId: randomUUID(), status: "completed" } });
    const ctx = { params: Promise.resolve({ siteId: "home", taskId: task.id }) };
    expect((await loadWorkbook(request({}, "https://other.example"), ctx)).status).toBe(403);
    const big = new Request(base,{method:"POST",headers:{"content-type":"application/octet-stream","content-length":"6000000"},body:"x"});
    expect((await loadWorkbook(big, ctx)).status).toBe(413);
    expect((await saveSelection(request({ keywords: ["unseen"], revision: 1 }), ctx)).status).toBe(409);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.parse).not.toHaveBeenCalled();
  });
  it("replaces an encrypted key for the session owner and tests it without creating a task", async () => {
    const res = await setKey("replacement-placeholder");
    expect(await res.json()).toEqual({ connected: true, provider: "manus" });
    const saved = await db.apiKey.findUniqueOrThrow({ where: { userId_provider: { userId: "owner", provider: "manus" } } });
    expect(saved.encryptedLogin).toBeNull();
    expect(saved.encryptedPassword).not.toContain("placeholder");
    expect(decrypt(saved.encryptedPassword)).toBe("replacement-placeholder");
    const status = await (await keyStatus()).json();
    expect(status.manus).toMatchObject({ connected: true });
    expect(JSON.stringify(status)).not.toMatch(/placeholder|encryptedPassword/);
    expect(await (await checkKey(request({ provider: "manus", saved: true }))).json()).toEqual({ success: true });
    expect(state.check).toHaveBeenCalledWith("replacement-placeholder");
    state.userId = "other";
    expect((await (await keyStatus()).json()).manus.connected).toBe(false);
    expect((await checkKey(request({ provider: "manus", saved: true }))).status).toBe(404);
    expect((await submit({}, "away")).status).toBe(409);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("requires the current user's site, a confirmed JSON request, and an acceptable origin", async () => {
    expect((await submit({ confirmed: false })).status).toBe(409);
    expect((await submit({ seeds: [] })).status).toBe(400);
    expect((await submit({ seeds: ["owner-placeholder"] })).status).toBe(400);
    expect((await submit({ requestId: "not-a-uuid" })).status).toBe(400);
    expect((await submit({}, "away")).status).toBe(404);
    const foreign = "https://other.test";
    expect((await POST(request({}, foreign), context())).status).toBe(403);
    expect((await update("absent", "home", foreign)).status).toBe(403);
    expect((await saveKey(request({ provider: "manus", apiKey: "unused" }, foreign))).status).toBe(403);
    expect((await removeKey(request({ provider: "manus" }, foreign, "DELETE"))).status).toBe(403);
    expect((await checkKey(request({ provider: "manus", saved: true }, foreign))).status).toBe(403);
    state.userId = "";
    expect((await list()).status).toBe(401);
    expect((await submit({})).status).toBe(401);
    expect(await db.manusKeywordTask.count()).toBe(0);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("claims a paid submission once under concurrency and rejects changed data on replay", async () => {
    const requestId = randomUUID();
    const replies = await Promise.all(Array.from({ length: 4 }, () => submit({ requestId })));
    const tasks = await Promise.all(replies.map(async r => (await r.json()).task));
    expect(new Set(tasks.map(t => t.id)).size).toBe(1);
    expect(await db.manusKeywordTask.count()).toBe(1);
    expect(state.create).toHaveBeenCalledExactlyOnceWith("owner-placeholder", input);
    expect((await submit({ requestId, language: "de" })).status).toBe(409);
    expect(await (await submit({ requestId })).json()).toMatchObject({ task: { id: tasks[0].id, status: "pending" } });
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("records rejected and uncertain submissions and never retries them", async () => {
    for (const [ambiguous, status] of [[false, "failed"], [true, "unknown"]] as const) {
      const requestId = randomUUID();
      state.create.mockRejectedValueOnce(new ManusError(ambiguous ? "network" : "unauthorized", ambiguous));
      const { task } = await (await submit({ requestId })).json();
      expect(task).toMatchObject({ status, refreshable: false, requestId, files: [] });
      expect((await (await submit({ requestId })).json()).task).toEqual(task);
      expect((await (await update(task.id)).json()).task).toEqual(task);
    }
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.read).not.toHaveBeenCalled();
    const requestId = randomUUID();
    await db.manusKeywordTask.create({ data: { userId: "owner", siteId: "home", input, requestId,
      status: "submitting", createdAt: new Date(Date.now() - 180_000) } });
    expect((await (await submit({ requestId })).json()).task.status).toBe("unknown");
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it("refreshes with the saved owner key and keeps completed results after read errors or key removal", async () => {
    const { task } = await (await submit({ userId: "other", remoteId: "untrusted" })).json();
    const listing = await list();
    expect(listing.headers.get("cache-control")).toBe("private, no-store");
    expect(await listing.json()).toMatchObject({ tasks: [task], connected: true, nextCursor: null });
    expect(state.read).not.toHaveBeenCalled();
    state.userId = "other";
    expect((await list()).status).toBe(404);
    expect((await update(task.id)).status).toBe(404);
    expect((await update(task.id, "away")).status).toBe(404);
    state.userId = "owner";
    const completed = (await (await update(task.id)).json()).task;
    expect(completed).toMatchObject({ status: "completed", result: "Research summary", refreshable: true, files: [{ name: "sheet.xlsx" }] });
    expect(state.read).toHaveBeenCalledExactlyOnceWith("owner-placeholder", "remote");
    state.read.mockRejectedValueOnce(new ManusError("network"));
    expect((await update(task.id)).status).toBe(502);
    await removeKey(request({ provider: "manus" }, "http://localhost", "DELETE"));
    expect((await update(task.id)).status).toBe(409);
    expect(await (await list()).json()).toMatchObject({ connected: false, tasks: [completed] });
    expect(state.create).toHaveBeenCalledOnce();
  });
});
