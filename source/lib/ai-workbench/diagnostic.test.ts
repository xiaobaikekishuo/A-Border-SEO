import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { getGscDateRange } from "@/lib/date-utils";
import { getDiagnosticEvidence } from "./diagnostic";
import { runWorkbenchAction, getWorkbenchWorkspace } from "./data";

let database: TestDb; let db: PrismaClient;
const now = new Date();
const period = getGscDateRange(28);
const date = new Date(`${period.end}T00:00:00Z`);
const url = "https://diagnostic.example/guide";
const request = { action: "start", kind: "SEO_FIX_PLAN", title: "Review page", diagnosis: { pageId: "diagnostic-page", crawlId: "diagnostic-crawl", query: "guide" } };
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: "diagnostic-owner", email: "owner@diagnostic.example" }, { id: "diagnostic-other", email: "other@diagnostic.example" }] });
  await db.site.createMany({ data: [{ id: "diagnostic-site", userId: "diagnostic-owner", domain: "diagnostic.example", gscProperty: "sc-domain:diagnostic.example" }, { id: "diagnostic-foreign", userId: "diagnostic-other", domain: "foreign.example" }] });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.aiWorkbenchJob.deleteMany(); await db.crawl.deleteMany(); await db.page.deleteMany(); await db.queryPage.deleteMany(); await db.gscSyncCoverage.deleteMany(); await db.contentWorkerState.deleteMany();
  await db.contentWorkerState.create({ data: { id: "diagnostic-worker", lastSeenAt: now } });
  await db.crawl.createMany({ data: [{ id: "diagnostic-crawl", siteId: "diagnostic-site", status: "COMPLETED", finishedAt: now }, { id: "diagnostic-foreign-crawl", siteId: "diagnostic-foreign", status: "COMPLETED", finishedAt: now }] });
  await db.auditPage.createMany({ data: [
    { id: "diagnostic-page", crawlId: "diagnostic-crawl", url, title: "A guide", statusCode: 200, articleText: "Visible original content. ".repeat(20) },
    { id: "diagnostic-second", crawlId: "diagnostic-crawl", url: "https://diagnostic.example/compare", title: "Comparison", statusCode: 200 },
    { id: "diagnostic-secret", crawlId: "diagnostic-foreign-crawl", url: "https://foreign.example/secret", statusCode: 200, articleText: "FOREIGN SECRET" },
  ] });
});
const preview = (selection: unknown = { pageId: "diagnostic-page" }, user: string | null = "diagnostic-owner", site = "diagnostic-site") => getDiagnosticEvidence(db, user, site, selection);

describe("saved single-page evidence", () => {
  it("enforces owner and latest-crawl page isolation before returning text", async () => {
    await expect(preview({}, null)).rejects.toMatchObject({ status: 401 });
    await expect(preview({}, "diagnostic-other")).rejects.toMatchObject({ status: 404 });
    await expect(preview({ pageId: "diagnostic-secret" })).rejects.toMatchObject({ status: 404 });
    await expect(preview({ url: "https://foreign.example/secret" })).rejects.toMatchObject({ status: 400 });
    await expect(preview({ url: "https://diagnostic.example/invented" })).rejects.toMatchObject({ status: 404 });
  });
  it("rejects stale previews and arbitrary client metrics", async () => {
    await expect(preview({ pageId: "diagnostic-page", crawlId: "old-crawl" })).rejects.toMatchObject({ status: 409 });
    await expect(preview({ pageId: "diagnostic-page", clicks: 999 })).rejects.toThrow();
    await expect(runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", { ...request, diagnosis: { ...request.diagnosis, searchEvidence: { clicks: 999 } } }, now)).rejects.toThrow();
    expect(await db.aiWorkbenchJob.count()).toBe(0);
  });
  it("keeps old schema and incomplete GSC unknown, rather than reporting missing or zero", async () => {
    const evidence = await preview();
    expect(evidence.schemaReport).toBeNull();
    expect(evidence.page?.bodySource).toBe("CRAWL");
    expect(evidence.searchEvidence.pages[0]).toMatchObject({ status: "UNKNOWN", clicks: null, impressions: null });
    expect(evidence.crawl?.finishedAt).toBe(now.toISOString());
  });
  it("returns only recorded query-page candidates and does not guess a landing page", async () => {
    await db.queryPage.createMany({ data: [
      { siteId: "diagnostic-site", query: "guide", page: url, date, impressions: 10 },
      { siteId: "diagnostic-site", query: "guide", page: "https://diagnostic.example/compare", date, impressions: 5 },
      { siteId: "diagnostic-foreign", query: "guide", page: "https://foreign.example/secret", date, impressions: 999 },
    ] });
    const evidence = await preview({ query: "guide", opportunity: "striking_distance" });
    expect(evidence.page).toBeNull();
    expect(evidence.pages.map(p => p.url)).toEqual([url, "https://diagnostic.example/compare"]);
    expect((await preview({ query: "never observed" })).pages).toEqual([]);
    await expect(runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", { ...request, diagnosis: { query: "guide" } }, now)).rejects.toMatchObject({ status: 400 });
  });
  it("supports a saved GSC-only URL without inventing body or schema evidence", async () => {
    const gscUrl = "https://diagnostic.example/not-crawled";
    await db.page.create({ data: { siteId: "diagnostic-site", url: gscUrl, date, clicks: 5, impressions: 100 } });
    const evidence = await preview({ url: gscUrl });
    expect(evidence.page).toBeNull(); expect(evidence.schemaReport).toBeNull();
    expect(evidence.pages).toEqual([{ id: null, url: gscUrl, title: null, hasBody: false }]);
    await expect(runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", { ...request, kind: "REWRITE_ARTICLE", diagnosis: { url: gscUrl } }, now)).rejects.toThrow("body is missing");
  });
  it("reports focused-query metrics only after all 28 dates are complete", async () => {
    await db.queryPage.create({ data: { siteId: "diagnostic-site", query: "guide", page: url, date, clicks: 3, impressions: 100, position: 4 } });
    expect((await preview({ pageId: "diagnostic-page", query: "guide" })).queryEvidence).toMatchObject({ status: "UNKNOWN", clicks: null });
    const coverage = Array.from({ length: 28 }, (_, i) => { const day = new Date(`${period.start}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + i); return { siteId: "diagnostic-site", gscProperty: "sc-domain:diagnostic.example", date: day, pagesComplete: true, queryPagesComplete: true }; });
    await db.gscSyncCoverage.createMany({ data: coverage });
    expect((await preview({ pageId: "diagnostic-page", query: "guide" })).queryEvidence).toMatchObject({ status: "REPORTED", clicks: 3, impressions: 100, position: 4, ctr: 0.03 });
  });
  it("excludes reviewed false positives and preserves unverified disposition in previews and task context", async () => {
    await db.crawlIssue.createMany({ data: [
      { crawlId: "diagnostic-crawl", url, type: "DUPLICATE_TITLE", severity: "WARNING", message: "EXCLUDED FINDING", details: { kind: "audit_excluded" } },
      { crawlId: "diagnostic-crawl", url, type: "MISSING_CANONICAL", severity: "INFO", message: "Check graph coverage", details: { kind: "orphan", auditPolicy: { disposition: "unverified" } } },
    ] });
    const evidence = await preview(); expect(evidence.issues).toHaveLength(1); expect(evidence.issues[0].disposition).toBe("unverified");
    const action = await runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", request, now);
    expect(action).toHaveProperty("jobId");
    const stored = await db.aiWorkbenchJob.findFirstOrThrow();
    expect(JSON.stringify(stored.context)).not.toContain("EXCLUDED FINDING");
    expect(stored.context).toMatchObject({ diagnosis: { selection: { url }, schemaReport: null }, issues: [{ disposition: "unverified" }] });
    const workspace = await getWorkbenchWorkspace(db, "diagnostic-owner", "diagnostic-site", now);
    expect(workspace.jobs[0].diagnosis?.page).not.toHaveProperty("body");
    expect(workspace.jobs[0]).not.toHaveProperty("context");
  });
  it("selects pages beyond the workspace sample by their authorized identifier", async () => {
    await db.auditPage.createMany({ data: Array.from({ length: 151 }, (_, i) => ({ id: `diagnostic-extra-${i}`, crawlId: "diagnostic-crawl", url: `https://diagnostic.example/a${String(i).padStart(3, "0")}`, statusCode: 200 })) });
    const workspace = await getWorkbenchWorkspace(db, "diagnostic-owner", "diagnostic-site", now);
    expect(workspace.pages.some(p => p.id === "diagnostic-page")).toBe(false);
    expect((await preview()).page?.id).toBe("diagnostic-page");
    await expect(runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", request, now)).resolves.toHaveProperty("jobId");
  });
  it("carries sample limits and explicitly marks the captured body as an excerpt", async () => {
    await db.auditPage.update({ where: { id: "diagnostic-page" }, data: { articleText: "文".repeat(13000) } });
    await db.queryPage.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ siteId: "diagnostic-site", query: "many pages", page: `https://diagnostic.example/sample-${i}`, date, impressions: i + 1 })) });
    await db.crawlIssue.createMany({ data: Array.from({ length: 31 }, (_, i) => ({ crawlId: "diagnostic-crawl", url, type: "MISSING_TITLE" as const, severity: "WARNING" as const, message: `Observation ${i}` })) });
    const preview = await getDiagnosticEvidence(db, "diagnostic-owner", "diagnostic-site", { pageId: "diagnostic-page", query: "many pages" });
    expect(preview.pages).toHaveLength(50); expect(preview.pages.some(p => p.url === url)).toBe(true);
    expect(preview.issues).toHaveLength(30); expect(preview.page?.body).toHaveLength(12000);
    expect(preview.limits).toEqual({ queryCandidates: 50, auditIssues: 30, bodyCharacters: 12000, bodyIsExcerpt: true, queryCandidatesAtLimit: true, auditIssuesAtLimit: true });
    await runWorkbenchAction(db, "diagnostic-owner", "diagnostic-site", request, now);
    const job = await db.aiWorkbenchJob.findFirstOrThrow();
    expect(job.context).toMatchObject({ bodyEvidence: { characterLimit: 12000, characters: 12000, isExcerpt: true, completeness: "UNKNOWN" }, evidenceLimits: { queryCandidates: 50, auditIssues: 30 }, diagnosis: { limits: { bodyIsExcerpt: true } } });
  });
});
