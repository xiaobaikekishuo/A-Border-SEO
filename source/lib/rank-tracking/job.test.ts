import type { Job, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Rank tracking end to end on PGlite: settings and keywords, a run posted to a
// fake DataForSEO standard queue, collected in later passes, and read back.

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});

import { encrypt } from "@/lib/encryption";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runRankCheck, runRankCollect } from "./job";
import { addTrackedKeywords, keywordHistory, rankRunPlan, readRankWorkspace, saveRankSettings, setTracked } from "./tracking";

let t: TestDb;
let db: PrismaClient;
const SITE = "rank-site";
const BASE = "https://api.dataforseo.com/v3/serp/google/organic";
const signal = new AbortController().signal;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
  t = await createTestDb();
  db = holder.db = t.db;
  await db.user.createMany({ data: [{ id: "owner", email: "owner@local.test" }, { id: "other", email: "other@local.test" }] });
  await db.site.create({ data: { id: SITE, userId: "owner", domain: "kammakhome.com" } });
}, 120_000);
afterAll(async () => { await t?.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

function job(id: string, type = "rank-check"): Job {
  return { id, type, siteId: SITE, source: "manual", attempts: 1, maxAttempts: 3 } as unknown as Job;
}

/** DataForSEO's standard queue for the tests: tasks are ready when the test says so. */
type Fake = { posted: { id: string; tag: string; keyword: string }[]; ready: Set<string>; positions: Record<string, number | null>; calls: string[]; loseNextPostAnswer: boolean };
function fakeDataForSeo(): Fake {
  const fake: Fake = { posted: [], ready: new Set(), positions: {}, calls: [], loseNextPostAnswer: false };
  const organic = (rank: number, domain: string, path = "/") => ({ type: "organic", rank_group: rank, rank_absolute: rank, domain, url: `https://${domain}${path}`, title: `${domain} ${rank}` });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(BASE, "");
    fake.calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/task_post") {
      const tasks = JSON.parse(String(init?.body)) as { keyword: string; tag: string }[];
      const created = tasks.map((task, i) => ({ id: `task-${fake.posted.length + i + 1}`, status_code: 20100, status_message: "Task Created.", cost: 0.0018, data: { tag: task.tag } }));
      fake.posted.push(...tasks.map((task, i) => ({ id: created[i].id, tag: task.tag, keyword: decodeURIComponent(task.keyword) })));
      if (fake.loseNextPostAnswer) {
        fake.loseNextPostAnswer = false;
        return new Response("bad gateway", { status: 502 });
      }
      return Response.json({ status_code: 20000, tasks: created });
    }
    if (path === "/tasks_ready") {
      const result = fake.posted.filter(p => fake.ready.has(p.id)).map(p => ({ id: p.id, tag: p.tag }));
      return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result }] });
    }
    const id = path.split("/").pop() ?? "";
    const task = fake.posted.find(p => p.id === id);
    if (!task || !fake.ready.has(id)) return Response.json({ status_code: 20000, tasks: [{ id, status_code: 40602, status_message: "Task In Queue.", result: null }] });
    const position = fake.positions[task.keyword] ?? null;
    const items = [organic(1, "rival.test"), ...(position ? [organic(position, "kammakhome.com", "/sofa")] : [])];
    return Response.json({ status_code: 20000, tasks: [{ id, status_code: 20000, result: [{ keyword: task.keyword, datetime: "2026-11-19 08:00:00 +00:00", item_types: ["organic"], items }] }] });
  }));
  return fake;
}

const readyAll = (fake: Fake) => fake.posted.forEach(p => fake.ready.add(p.id));
const posts = (fake: Fake) => fake.calls.filter(c => c.startsWith("POST")).length;

describe("rank tracking", () => {
  it("keeps keywords and settings per owned site", async () => {
    await expect(readRankWorkspace(db, "other", SITE)).rejects.toMatchObject({ status: 404 });
    await expect(addTrackedKeywords(db, "other", SITE, { keywords: ["sofa beds"] })).rejects.toMatchObject({ status: 404 });
    await expect(rankRunPlan(db, "owner", SITE)).rejects.toMatchObject({ status: 422 });

    const added = await addTrackedKeywords(db, "owner", SITE, { keywords: ["sofa beds", "corner  sofa", "sofa beds", "site:kammakhome.com sofa"] });
    expect(added).toEqual({ saved: 3, tracked: 2, operators: 1, overLimit: 0 });
    await saveRankSettings(db, "owner", SITE, { device: "desktop", depth: 30, aiOverview: false, scheduleDays: 7, budgetUsd: 1 });
    const workspace = await readRankWorkspace(db, "owner", SITE);
    expect(workspace.rows.filter(r => r.tracked).map(r => r.keyword).sort()).toEqual(["corner sofa", "sofa beds"]);
    expect(workspace.rows.find(r => r.operator)).toMatchObject({ keyword: "site:kammakhome.com sofa", tracked: false });
    expect(workspace.estimate).toEqual({ tasks: 2, usd: 0.0036, skipped: 0 });
    expect(workspace.monthlyUsd).toBeCloseTo(0.0154, 4);
    expect(workspace.credentials).toBe(false);
    await expect(rankRunPlan(db, "owner", SITE)).rejects.toThrow("DataForSEO");

    // The operator cannot be tracked by hand either.
    const operator = workspace.rows.find(r => r.operator)!;
    expect(await setTracked(db, "owner", SITE, { ids: [operator.id], tracked: true })).toEqual({ updated: 0, operators: 1, overLimit: 0 });
  });

  it("posts a run, collects it once the tasks are ready, and reads the positions", async () => {
    await db.apiKey.create({ data: { userId: "owner", provider: "dataforseo", encryptedLogin: encrypt("login"), encryptedPassword: encrypt("password") } });
    expect(await rankRunPlan(db, "owner", SITE)).toMatchObject({ tasks: 2, usd: 0.0036 });
    const fake = fakeDataForSeo();
    fake.positions = { "sofa beds": 4, "corner sofa": null };

    expect(await runRankCheck({ db, job: job("check-1"), workerId: "test", signal })).toMatchObject({ status: "WAITING", posted: 2, costUsd: 0.0036 });
    expect(posts(fake)).toBe(1);
    // A retry of the posting job posts nothing again.
    await runRankCheck({ db, job: job("check-1"), workerId: "test", signal });
    expect(posts(fake)).toBe(1);
    const collector = await db.job.findFirstOrThrow({ where: { siteId: SITE, type: "rank-collect", status: "QUEUED" } });
    expect(collector.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // Nothing is ready yet: the collector asks for the list only, and queues its next pass.
    expect(await runRankCollect({ db, job: job(collector.id, "rank-collect"), workerId: "test", signal })).toEqual({ waiting: 1, finished: 0 });
    expect(fake.calls.filter(c => c.includes("/task_get/"))).toEqual([]);

    readyAll(fake);
    expect(await runRankCollect({ db, job: job(collector.id, "rank-collect"), workerId: "test", signal })).toEqual({ waiting: 0, finished: 1 });
    const workspace = await readRankWorkspace(db, "owner", SITE);
    expect(workspace.runs[0]).toMatchObject({ status: "SUCCEEDED", planned: 2, checks: 2, done: 2, failed: 0 });
    expect(workspace.runs[0].costUsd).toBeCloseTo(0.0036, 6);
    expect(workspace.rows.find(r => r.keyword === "sofa beds")?.latest).toMatchObject({ position: 4, url: "https://kammakhome.com/sofa" });
    expect(workspace.rows.find(r => r.keyword === "corner sofa")?.latest).toMatchObject({ position: null, url: null });
    expect(workspace.summary).toMatchObject({ tracked: 2, checked: 2, top10: 1, notRanked: 1 });

    const history = await keywordHistory(db, "owner", SITE, "sofa beds");
    expect(history.checks).toHaveLength(1);
    expect(history.top.map(r => r.domain)).toEqual(["rival.test", "kammakhome.com"]);
    await expect(keywordHistory(db, "other", SITE, "sofa beds")).rejects.toMatchObject({ status: 404 });
  });

  it("collects a batch whose post went unanswered by its tags, without posting it again", async () => {
    const fake = fakeDataForSeo();
    fake.positions = { "sofa beds": 2, "corner sofa": 9 };
    fake.loseNextPostAnswer = true;
    expect(await runRankCheck({ db, job: job("check-2"), workerId: "test", signal })).toMatchObject({ status: "WAITING", posted: 2 });
    expect(posts(fake)).toBe(1);
    readyAll(fake);
    expect(await runRankCollect({ db, job: job("collect-2", "rank-collect"), workerId: "test", signal })).toEqual({ waiting: 0, finished: 1 });
    expect(posts(fake)).toBe(1);

    const workspace = await readRankWorkspace(db, "owner", SITE);
    // Adopted tasks are paid at about the estimate.
    expect(workspace.runs[0].costUsd).toBeCloseTo(0.0036, 6);
    expect(workspace.rows.find(r => r.keyword === "sofa beds")).toMatchObject({ change: 2, movement: "UP" });
    expect(workspace.rows.find(r => r.keyword === "corner sofa")).toMatchObject({ change: null, movement: "ENTERED" });
    expect(workspace.summary).toMatchObject({ top3: 1, top10: 2, up: 2, down: 0 });
  });

  it("checks only what the budget covers, and fails checks that never come back", async () => {
    await addTrackedKeywords(db, "owner", SITE, { keywords: Array.from({ length: 10 }, (_, i) => `sofa ${i + 1}`) });
    // $0.006 per keyword at 100 results: 8 of the 12 tracked keywords fit in $0.05.
    await saveRankSettings(db, "owner", SITE, { device: "mobile", depth: 100, aiOverview: false, scheduleDays: null, budgetUsd: 0.05 });
    expect(await rankRunPlan(db, "owner", SITE)).toMatchObject({ tasks: 8, skipped: 4 });
    const fake = fakeDataForSeo();
    await runRankCheck({ db, job: job("check-3"), workerId: "test", signal });
    const run = await db.rankRun.findUniqueOrThrow({ where: { jobId: "check-3" } });
    expect(run).toMatchObject({ planned: 12, device: "mobile", depth: 100 });
    expect(await db.rankCheck.count({ where: { runId: run.id } })).toBe(8);

    // A day later only half came back; the rest fail and the run closes.
    fake.posted.slice(0, 4).forEach(p => fake.ready.add(p.id));
    await db.rankRun.update({ where: { id: run.id }, data: { postedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
    expect(await runRankCollect({ db, job: job("collect-3", "rank-collect"), workerId: "test", signal })).toEqual({ waiting: 0, finished: 1 });
    const closed = await db.rankRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(closed).toMatchObject({ status: "PARTIAL", done: 8, failed: 4, errorCode: "BUDGET" });
    expect(await db.rankCheck.count({ where: { runId: run.id, status: "FAILED", error: "DataForSEO returned no result within 24 hours" } })).toBe(4);

    // Turning tracking off keeps the saved keywords and their history.
    const workspace = await readRankWorkspace(db, "owner", SITE);
    const ids = workspace.rows.filter(r => /^sofa \d+$/.test(r.keyword)).map(r => r.id);
    expect(await setTracked(db, "owner", SITE, { ids, tracked: false })).toMatchObject({ updated: 10 });
    expect(await db.savedKeyword.count({ where: { siteId: SITE, tracked: true } })).toBe(2);
  });
});
