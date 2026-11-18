import type { Job } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/encryption";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { readPlatformOverview } from "./platform-overview";
import { deleteAiReport, readAiReports, saveAiReport } from "./report-store";
import {
  addPrompts, deleteManualAnswer, deletePrompt, GEO_TRIAL_JOB, readAnswer, readTrackingWorkspace, recordManualAnswer, runPlan, saveTrackingSettings, updatePrompt,
} from "./tracking";
import { runVisibility } from "./visibility-job";

let testDb: TestDb;
const SITE = "geo-track";
const settings = {
  brands: { own: { name: "Kammak", aliases: [], domains: [] }, competitors: [{ name: "Acme", aliases: [], domains: ["acme.test"] }] },
  platforms: ["CHATGPT", "GOOGLE_AIO"],
  scheduleDays: null,
  budgetUsd: 1,
};

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
  testDb = await createTestDb();
  await testDb.db.user.createMany({ data: [{ id: "owner", email: "owner@local.test" }, { id: "other", email: "other@local.test" }] });
  await testDb.db.site.create({ data: { id: SITE, userId: "owner", domain: "kammakhome.com" } });
}, 120_000);
afterAll(async () => { await testDb?.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

function job(id: string, type = "geo-visibility"): Job {
  return { id, type, siteId: SITE, source: "manual", attempts: 1, maxAttempts: 3 } as unknown as Job;
}

/**
 * DataForSEO for the tests: ChatGPT cites the site, the AI Overview is missing
 * for the second prompt. `overviewError`: every AI Overview task fails with that
 * DataForSEO task status instead.
 */
function stubDataForSeo(calls: string[], overviewError?: number) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push(String(url));
    const [task] = JSON.parse(String(init.body)) as { keyword: string }[];
    if (String(url).includes("/serp/google/organic/")) {
      if (overviewError) return Response.json({ status_code: 20000, tasks: [{ status_code: overviewError, status_message: "Invalid Field: 'keyword'.", cost: 0, result: null }] });
      const result = task.keyword.includes("second")
        ? { status_code: 20000, tasks: [{ status_code: 40102, cost: 0.004, result: null }] }
        : { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ items: [{ type: "ai_overview", markdown: "Acme is a choice", references: [{ url: "https://acme.test/x" }] }] }] }] };
      return Response.json(result);
    }
    return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ markdown: "Kammak is good", sources: [{ url: "https://kammakhome.com/sofa" }] }] }] });
  }));
}

describe("prompt tracking", () => {
  it("keeps settings and prompts per owned site", async () => {
    const db = testDb.db;
    await expect(readTrackingWorkspace(db, "other", SITE)).rejects.toMatchObject({ status: 404 });
    await expect(saveTrackingSettings(db, "other", SITE, settings)).rejects.toMatchObject({ status: 404 });
    await expect(runPlan(db, "owner", SITE)).rejects.toMatchObject({ status: 422 });
    await saveTrackingSettings(db, "owner", SITE, settings);
    const added = await addPrompts(db, "owner", SITE, { prompts: [{ text: "best sofa brand" }, { text: "best sofa brand" }, { text: "second  question about sofas", tag: "sofa" }] });
    expect(added).toEqual({ added: 2, skipped: 0 });
    expect(await addPrompts(db, "owner", SITE, { prompts: [{ text: "best sofa brand" }] })).toEqual({ added: 0, skipped: 1 });
    const workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.settings?.brands.own.domains).toEqual(["kammakhome.com"]);
    expect(workspace.prompts.map(p => p.text).sort()).toEqual(["best sofa brand", "second question about sofas"]);
    expect(workspace.estimate).toEqual({ tasks: 4, usd: 0.016 });
    expect(workspace.credentials).toBe(false);
    await expect(runPlan(db, "owner", SITE)).rejects.toThrow("DataForSEO");
  });

  it("runs every prompt on every platform, resumes without asking twice, and reads the answers", async () => {
    const db = testDb.db;
    await db.apiKey.create({ data: { userId: "owner", provider: "dataforseo", encryptedLogin: encrypt("login"), encryptedPassword: encrypt("password") } });
    expect(await runPlan(db, "owner", SITE)).toMatchObject({ tasks: 4 });
    const calls: string[] = [];
    stubDataForSeo(calls);
    const signal = new AbortController().signal;
    const result = await runVisibility({ db, job: job("job-1"), workerId: "test", signal });
    expect(result).toMatchObject({ status: "SUCCEEDED", planned: 4, done: 4, failed: 0 });
    expect(calls).toHaveLength(4);
    // A retry of the same job finds the run finished and asks nothing.
    await runVisibility({ db, job: job("job-1"), workerId: "test", signal });
    expect(calls).toHaveLength(4);

    const workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.runs[0]).toMatchObject({ status: "SUCCEEDED", done: 4 });
    expect(workspace.runs[0].costUsd).toBeCloseTo(0.016, 6);
    expect(workspace.latest.platforms.CHATGPT).toMatchObject({ answers: 2, mentionRate: 1, citationRate: 1 });
    expect(workspace.latest.platforms.GOOGLE_AIO).toMatchObject({ answers: 1, noAnswer: 1, mentionRate: 0 });
    const cell = workspace.latest.cells.find(c => c.platform === "GOOGLE_AIO" && c.status === "OK")!;
    expect(cell.competitors).toEqual(["Acme"]);
    const answer = await readAnswer(db, "owner", SITE, cell.answerId);
    expect(answer.citations[0]).toMatchObject({ domain: "acme.test", owner: "Acme" });
    await expect(readAnswer(db, "other", SITE, cell.answerId)).rejects.toMatchObject({ status: 404 });

    // A later failed attempt does not hide the answer it follows.
    const okCell = workspace.latest.cells.find(c => c.platform === "CHATGPT")!;
    await db.geoAnswer.create({ data: { siteId: SITE, promptId: okCell.promptId, platform: "CHATGPT", source: "DATAFORSEO", status: "FAILED", citations: [], error: "DataForSEO status 50000" } });
    const after = await readTrackingWorkspace(db, "owner", SITE);
    expect(after.latest.platforms.CHATGPT).toMatchObject({ answers: 2, failed: 0, mentionRate: 1 });
  });

  it("drops a prompt deleted after the run was planned", async () => {
    const db = testDb.db;
    const [first] = (await readTrackingWorkspace(db, "owner", SITE)).prompts.filter(p => p.active);
    await db.geoRun.create({
      data: {
        siteId: SITE, jobId: "job-planned", source: "manual", status: "RUNNING", planned: 2, budgetUsd: 1,
        plan: { prompts: [first.id, "prompt-deleted-meanwhile"], platforms: ["CHATGPT"], market: { language: "en", location: 2840 }, claudeModel: null },
      },
    });
    const calls: string[] = [];
    stubDataForSeo(calls);
    const result = await runVisibility({ db, job: job("job-planned"), workerId: "test", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "SUCCEEDED", planned: 1, done: 1, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a trial asks only the first active prompt on each platform, and is marked as one", async () => {
    const db = testDb.db;
    const workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.trialEstimate).toEqual({ tasks: 2, usd: 0.008 });
    expect(await runPlan(db, "owner", SITE, { trial: true })).toMatchObject({ tasks: 2, trial: true });
    const calls: string[] = [];
    stubDataForSeo(calls);
    const result = await runVisibility({ db, job: job("job-trial", GEO_TRIAL_JOB), workerId: "test", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "SUCCEEDED", planned: 2, done: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    const run = (await readTrackingWorkspace(db, "owner", SITE)).runs[0];
    expect(run).toMatchObject({ trial: true, planned: 2, source: "manual" });
    const first = workspace.prompts.find(p => p.active)!;
    expect(await db.geoAnswer.count({ where: { runId: run.id, promptId: { not: first.id } } })).toBe(0);
    expect(workspace.runs.every(r => r.trial === false)).toBe(true);
  });

  it("a failed task fails only its answer, and the run ends partial", async () => {
    const db = testDb.db;
    const calls: string[] = [];
    stubDataForSeo(calls, 40501);
    const result = await runVisibility({ db, job: job("job-failing"), workerId: "test", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "PARTIAL", planned: 4, done: 4, failed: 2 });
    expect(calls).toHaveLength(4);
    const workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.runs[0]).toMatchObject({ status: "PARTIAL", failed: 2, errorCode: null });
    const failed = await db.geoAnswer.findFirstOrThrow({ where: { runId: workspace.runs[0].id, status: "FAILED" } });
    expect(failed).toMatchObject({ platform: "GOOGLE_AIO" });
    expect(failed.error).toContain("40501");
    // The earlier answers of the AI Overview still stand in the latest view.
    expect(workspace.latest.platforms.GOOGLE_AIO).toMatchObject({ failed: 0 });
  });

  it("stops at the budget", async () => {
    const db = testDb.db;
    await saveTrackingSettings(db, "owner", SITE, { ...settings, budgetUsd: 0.05 });
    await addPrompts(db, "owner", SITE, { prompts: Array.from({ length: 10 }, (_, i) => ({ text: `budget prompt ${i}` })) });
    const calls: string[] = [];
    stubDataForSeo(calls);
    const result = await runVisibility({ db, job: job("job-2"), workerId: "test", signal: new AbortController().signal });
    expect(result.status).toBe("PARTIAL");
    expect(calls.length).toBeLessThanOrEqual(12);
    const run = (await readTrackingWorkspace(db, "owner", SITE)).runs[0];
    expect(run).toMatchObject({ errorCode: "BUDGET" });
    expect(run.costUsd).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("records answers by hand, and deletes prompts with their answers", async () => {
    const db = testDb.db;
    const prompt = (await readTrackingWorkspace(db, "owner", SITE)).prompts[0];
    const { id } = await recordManualAnswer(db, "owner", SITE, { promptId: prompt.id, platform: "COPILOT", status: "OK", text: "Try Kammak", citations: ["https://kammakhome.com/?utm_source=copilot"] });
    let workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.latest.platforms.COPILOT).toMatchObject({ answers: 1, mentionRate: 1, citationRate: 1 });
    await expect(recordManualAnswer(db, "owner", SITE, { promptId: prompt.id, platform: "NOPE", status: "OK", text: "x", citations: [] })).rejects.toMatchObject({ status: 422 });
    await deleteManualAnswer(db, "owner", SITE, id);
    await updatePrompt(db, "owner", SITE, { id: prompt.id, active: false });
    workspace = await readTrackingWorkspace(db, "owner", SITE);
    expect(workspace.latest.cells.some(c => c.promptId === prompt.id)).toBe(false);
    await deletePrompt(db, "owner", SITE, prompt.id);
    expect(await db.geoAnswer.count({ where: { promptId: prompt.id } })).toBe(0);
  });
});

describe("imported AI reports and the platform overview", () => {
  const report = {
    kind: "BING_AI", daily: [{ day: "2026-10-01", value: 12, pages: 3 }], pages: [{ url: "https://kammakhome.com/sofa", value: 12 }],
    queries: [], countries: [], devices: [], tables: ["DAILY", "PAGES"], skipped: 0, truncated: 0, ignored: [], expectedUpdatedAt: null,
  };

  it("counts distinct exposed URLs only on verified days for the current property and SEO period", async () => {
    const db = testDb.db, siteId = "geo-period-test", gscProperty = "sc-domain:current.test";
    // Still November 16 in California; the 28-day period ends on November 13.
    const now = new Date("2026-11-17T01:00:00Z");
    const day = (label: string) => new Date(label + "T00:00:00Z");
    await db.site.create({ data: { id: siteId, userId: "owner", domain: "current.test", gscProperty, bingSite: "https://current.test/" } });
    const read = () => readPlatformOverview(db, "owner", siteId, now);
    const extract = (overview: Awaited<ReturnType<typeof read>>, id = "GOOGLE_AIO") => overview.platforms.find(row => row.id === id)!.index;
    expect(extract(await read())).toMatchObject({ pages: null, state: "UNKNOWN", coverage: { days: 0, start: "2026-10-17", end: "2026-11-13" } });
    const coverage = (label: string, property = gscProperty, complete = true) => ({ siteId, date: day(label), gscProperty: property, pagesComplete: complete });
    await db.gscSyncCoverage.createMany({ data: [coverage("2026-10-16"), coverage("2026-10-17"), coverage("2026-11-13"),
      coverage("2026-11-01", "sc-domain:old.test"), coverage("2026-11-02", gscProperty, false), coverage("2026-11-14")] });
    const page = (label: string, name: string, impressions = 1) => ({ siteId, date: day(label), url: "https://current.test/" + name, impressions });
    await db.page.createMany({ data: [page("2026-10-16", "early"), page("2026-11-14", "recent"), page("2026-11-01", "old-property"), page("2026-11-02", "incomplete"),
      page("2026-10-18", "unverified"), page("2026-10-17", "no-impressions", 0)] });
    expect(extract(await read())).toMatchObject({ pages: null, coverage: { days: 2 } });
    await db.page.createMany({ data: [page("2026-10-17", "repeated"), page("2026-11-13", "repeated"), page("2026-11-13", "second")] });
    await db.bingDaily.createMany({ data: [{ siteId, date: day("2026-09-01"), inIndex: 138 }, { siteId, date: day("2026-11-13"), inIndex: null }] });
    const result = await read();
    for (const id of ["GOOGLE_AIO", "GOOGLE_AI_MODE", "GEMINI"])
      expect(extract(result, id)).toMatchObject({ pages: 2, state: "WARN", coverage: { days: 2, expected: 28 } });
    for (const id of ["CHATGPT", "COPILOT"])
      expect(extract(result, id)).toMatchObject({ pages: 138, at: "2026-09-01", state: "WARN", stale: true });
    await db.site.update({ where: { id: siteId }, data: { bingSite: null } });
    expect(extract(await read(), "CHATGPT")).toMatchObject({ pages: null, at: null, connected: false });
    await db.gscSyncCoverage.deleteMany({ where: { siteId } });
    await db.page.deleteMany({ where: { siteId } });
    await db.gscSyncCoverage.createMany({ data: Array.from({ length: 28 }, (_, i) => ({ siteId, gscProperty, pagesComplete: true,
      date: new Date(day("2026-10-17").getTime() + i * 86_400_000) })) });
    expect(extract(await read())).toMatchObject({ pages: 0, coverage: { days: 28 } });
    // Legacy coverage still describes returned page rows. An explicitly checked
    // but absent property-day, on the other hand, must not look like a real zero.
    await db.$executeRaw`UPDATE "GscSyncCoverage" SET "propertyChecked" = true
      WHERE "siteId" = ${siteId} AND "date" = '2026-11-13'::date`;
    expect(extract(await read())).toMatchObject({ pages: null, coverage: { days: 27 } });
    await db.$executeRaw`UPDATE "GscSyncCoverage" SET "propertyImpressions" = 0
      WHERE "siteId" = ${siteId} AND "date" = '2026-11-13'::date`;
    expect(extract(await read())).toMatchObject({ pages: 0, coverage: { days: 28 } });
  });

  it("checks a report against the site and keeps one per kind", async () => {
    const db = testDb.db;
    await expect(saveAiReport(db, "owner", SITE, { ...report, pages: [{ url: "https://other.test/", value: 1 }] })).rejects.toMatchObject({ status: 422 });
    const saved = await saveAiReport(db, "owner", SITE, report);
    expect(saved.BING_AI).toMatchObject({ start: "2026-10-01", end: "2026-10-01" });
    await expect(saveAiReport(db, "owner", SITE, report)).rejects.toMatchObject({ status: 409 });
    await expect(readAiReports(db, "other", SITE)).rejects.toMatchObject({ status: 404 });

    const overview = await readPlatformOverview(db, "owner", SITE);
    expect(overview.platforms).toHaveLength(10);
    expect(overview.platforms.find(p => p.id === "COPILOT")!.report).toMatchObject({ state: "GOOD", total: 12 });
    expect(overview.platforms.find(p => p.id === "CHATGPT")!.answers.state).toBe("GOOD");
    expect(overview.probe).toBeNull();

    expect((await deleteAiReport(db, "owner", SITE, "BING_AI")).BING_AI).toBeNull();
  });

  it("deleting the site removes its tracking settings, prompts, runs and answers", async () => {
    const db = testDb.db;
    const before = await Promise.all([db.geoTracking.count({ where: { siteId: SITE } }), db.geoPrompt.count({ where: { siteId: SITE } }), db.geoRun.count({ where: { siteId: SITE } }), db.geoAnswer.count({ where: { siteId: SITE } })]);
    expect(before.every(n => n > 0)).toBe(true);
    await db.site.delete({ where: { id: SITE } });
    expect(await Promise.all([db.geoTracking.count({ where: { siteId: SITE } }), db.geoPrompt.count({ where: { siteId: SITE } }), db.geoRun.count({ where: { siteId: SITE } }), db.geoAnswer.count({ where: { siteId: SITE } })])).toEqual([0, 0, 0, 0]);
  });
});
