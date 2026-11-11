import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { getAiUsage } from "./data";

let database: TestDb;
const now = new Date("2026-11-06T08:00:00Z");
beforeAll(async () => {
  database = await createTestDb(); const db = database.db;
  for (const id of ["usage-owner", "usage-other"]) await db.user.create({ data: { id, email: `${id}@example.test` } });
  for (const [id, userId] of [["usage-site-a", "usage-owner"], ["usage-site-b", "usage-owner"], ["usage-private", "usage-other"]])
    await db.site.create({ data: { id, userId, domain: `${id}.test` } });
  await db.contentPillar.create({ data: { id: "usage-pillar", siteId: "usage-site-b", title: "A content pillar", keyword: "sample" } });
  await db.contentPlanJob.create({ data: { id: "plan", siteId: "usage-site-b", pillarId: "usage-pillar", status: "SUCCEEDED", createdAt: now,
    usage: { source: "CODEX_CLI", inputTokens: 30, outputTokens: 10, totalTokens: 40 } } });
  await db.aiWorkbenchJob.createMany({ data: [
    { id: "own", siteId: "usage-site-a", title: "Own draft", kind: "WRITE_ARTICLE", status: "SUCCEEDED", createdAt: now,
      request: { provider: "CHATGPT_APP", model: "account-model", profileId: "must-not-leak", body: "private-user-text" }, context: { private: "context-must-not-leak" },
      usage: { source: "CHATGPT_RESPONSE", inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { id: "other", siteId: "usage-private", title: "OTHER_PRIVATE_TITLE", kind: "WRITE_ARTICLE", status: "SUCCEEDED", createdAt: now,
      request: { model: "other-model" }, context: {}, usage: { source: "CODEX_CLI", totalTokens: 999 } },
    { id: "old", siteId: "usage-site-a", title: "Old outside period", kind: "WRITE_ARTICLE", status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00Z"), request: {}, context: {} },
    { id: "future", siteId: "usage-site-a", title: "Future outside period", kind: "WRITE_ARTICLE", status: "SUCCEEDED", createdAt: new Date("2027-01-01T00:00:00Z"), request: {}, context: {} },
    { id: "dirty", siteId: "usage-site-a", title: "Invalid legacy telemetry", kind: "WRITE_ARTICLE", status: "FAILED", createdAt: now,
      request: ["secret"], context: {}, usage: { source: "CHATGPT_RESPONSE", inputTokens: "123" } },
  ] });
}, 120000);
afterAll(async () => { await database?.close(); });
describe("owned local AI usage", () => {
  it("includes both task types and only the signed-in user's sites and requested period", async () => {
    const report = await getAiUsage(database.db, "usage-owner", 30, null, now);
    expect(report.summary).toMatchObject({ tasks: 3, succeeded: 2, failed: 1, withUsage: 2, withoutUsage: 1, totalTokens: 160 });
    expect(report.recent.find(row => row.id === "own")).toMatchObject({ provider: "CHATGPT_APP", model: "account-model" });
    expect(report.recent.find(row => row.id === "plan")).toMatchObject({ provider: "CODEX_LOCAL", model: null, title: "A content pillar" });
    const serialized = JSON.stringify(report);
    for (const secret of ["OTHER_PRIVATE_TITLE", "must-not-leak", "private-user-text", "context-must-not-leak", "other-model"]) expect(serialized).not.toContain(secret);
  });
  it("requires login, rejects foreign sites and never mutates task records", async () => {
    await expect(getAiUsage(database.db, null, 30, null, now)).rejects.toMatchObject({ status: 401 });
    await expect(getAiUsage(database.db, "usage-owner", 30, "usage-private", now)).rejects.toMatchObject({ status: 404 });
    const before = await database.db.aiWorkbenchJob.findMany();
    const scoped = await getAiUsage(database.db, "usage-owner", 7, "usage-site-a", now);
    expect(scoped.summary.tasks).toBe(2);
    expect(await database.db.aiWorkbenchJob.findMany()).toEqual(before);
  });
});
