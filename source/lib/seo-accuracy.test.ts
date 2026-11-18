import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
const google = vi.hoisted(() => ({ fetchSearchAnalytics: vi.fn(), fetchPageAnalytics: vi.fn(), fetchPropertyAnalytics: vi.fn(), listGSCProperties: vi.fn(), ReauthRequiredError: class extends Error {} }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(holder) }));
vi.mock("@/lib/google", async () => ({ ...google, gscDate: (await import("@/lib/google/gsc-date")).gscDate }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u" } }) }));
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { getSitePeriodMetrics, getDailyTraffic, getTopKeywords, getTopPages } from "./seo-metrics";
import { getContentDecay, getCannibalization, getAllOpportunities } from "./seo-opportunities";
import { PUT as updateSite } from "@/app/api/sites/[siteId]/route";
import { GET as getSavedKeywords } from "@/app/api/sites/[siteId]/saved-keywords/route";
import { GET as getRankHistory } from "@/app/api/sites/[siteId]/rank-history/route";
import { getGscCoverage, gscComparisonWindows } from "./gsc-coverage";
import { runGSCSync } from "./workers/gsc-sync";
import { calculatePercentChange, getDataLagDate, getGscDateRange } from "./date-utils";
let test: TestDb;
let db: PrismaClient;
beforeAll(async () => { test = await createTestDb(); db = holder.db = test.db; }, 120000);
afterAll(async () => { vi.useRealTimers(); await test?.close(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T03:00:00Z"));
  await db.user.deleteMany();
  await db.user.create({ data: { id: "u", email: "metrics@example.test" } });
  await db.site.create({ data: { id: "s", userId: "u", domain: "example.test", gscProperty: "sc-domain:example.test" } });
  google.fetchSearchAnalytics.mockReset().mockResolvedValue([]);
  google.fetchPageAnalytics.mockReset().mockResolvedValue([]);
  google.fetchPropertyAnalytics.mockReset().mockResolvedValue([]);
});
const sync = () => runGSCSync("u", "s", "sc-domain:example.test");
const page = (date: string, clicks = 1) => ({ query: "", page: "https://example.test/a", date, clicks, impressions: 100, ctr: clicks / 100, position: 7.2 });

describe("GSC accuracy", () => {
  it("uses Pacific cutoff and exactly 28 + 28 adjacent dates", () => {
    expect(getDataLagDate()).toBe("2026-11-01");
    const { current, previous } = gscComparisonWindows();
    expect(current).toEqual({ start: "2026-10-05", end: "2026-11-01" });
    expect(previous).toEqual({ start: "2026-09-07", end: "2026-10-04" });
    expect(calculatePercentChange(5, 0)).toBeNull();
  });
  it("does not infer coverage or decline from legacy rows", async () => {
    const { current, previous } = gscComparisonWindows();
    await db.page.createMany({ data: [
      { siteId: "s", url: "https://example.test/a", date: new Date(current.start), clicks: 5, impressions: 100, position: 7.2 },
      { siteId: "s", url: "https://example.test/old", date: new Date(previous.start), clicks: 20, impressions: 100, position: 5 },
    ] });
    expect((await getSitePeriodMetrics("s")).coverage.currentReportedDays).toBe(0);
    await db.gscSyncCoverage.create({ data: { siteId: "s", gscProperty: "sc-domain:example.test", date: new Date(current.start), pagesComplete: true } });
    const metrics = await getSitePeriodMetrics("s");
    expect(metrics.current.clicks).toBe(5);
    expect(metrics.basis).toBe("page");
    expect(metrics.deltas).toEqual({ clicks: null, impressions: null, avgPosition: null, avgCtr: null });
    expect(await getContentDecay("s")).toEqual([]);
    expect(await getCannibalization("s")).toEqual([]);
  });
  it("records a successful empty fetch and replaces stale rows", async () => {
    google.fetchPageAnalytics.mockResolvedValueOnce([page(getDataLagDate())]);
    await sync();
    expect(await db.page.count()).toBe(1);
    await sync();
    expect(await db.page.count()).toBe(0);
    expect(await db.gscSyncCoverage.count()).toBe(56);
    expect((await getGscCoverage("s")).comparable).toBe(true);
    const metrics = await getSitePeriodMetrics("s");
    expect(metrics.deltas.clicks).toBeNull();
    expect(metrics.coverage.currentReportedDays).toBe(0);
    expect(metrics.deltas.avgPosition).toBeNull();
    expect(await getDailyTraffic("s", 28)).toEqual([]);
  });
  it("compares stable daily traffic without an artificial drop", async () => {
    const period = getGscDateRange(56);
    const rows = Array.from({ length: 56 }, (_, i) => page(new Date(new Date(period.start).getTime() + i * 86400000).toISOString().slice(0, 10)));
    google.fetchPageAnalytics.mockResolvedValue(rows);
    google.fetchPropertyAnalytics.mockResolvedValue(rows.map(row => ({ ...row, clicks: 3 })));
    await sync();
    const metrics = await getSitePeriodMetrics("s");
    expect(metrics.basis).toBe("property");
    expect(metrics.current.clicks).toBe(84);
    expect(metrics.previous.clicks).toBe(84);
    expect(metrics.current.avgCtr).toBeCloseTo(0.03);
    expect((await getDailyTraffic("s", 28)).reduce((n, d) => n + d.clicks, 0)).toBe(84);
    expect(metrics.deltas.clicks).toBe(0);
    expect(metrics.deltas.avgPosition).toBe(0);
    expect(await getContentDecay("s")).toEqual([]);
  });
  it("keeps query-page evidence separate from the combined query totals", async () => {
    google.fetchSearchAnalytics.mockResolvedValue([
      { ...page(getDataLagDate()), query: "guide", page: "https://example.test/a", impressions: 100 },
      { ...page(getDataLagDate()), query: "guide", page: "https://example.test/b", impressions: 80 },
    ]);
    const result = await sync();
    expect(result).toMatchObject({ keywordsInserted: 1, queryPagesInserted: 2, uniqueKeywords: 1 });
    expect((await db.keyword.findFirst())?.impressions).toBe(180);
    const competition = await getCannibalization("s");
    expect(competition[0].pages.map(row => row.impressions)).toEqual([100, 80]);
    await db.gscSyncCoverage.deleteMany({ where: { date: new Date(getDataLagDate()) } });
    expect(await getCannibalization("s")).toEqual([]);
  });
  it("keeps the previous good data and coverage when a refresh fails", async () => {
    google.fetchPageAnalytics.mockResolvedValue([page(getDataLagDate())]);
    await sync();
    const before = await db.page.findMany();
    google.fetchPageAnalytics.mockResolvedValue([{ ...page(getDataLagDate()), clicks: Number.NaN }]);
    await expect(sync()).rejects.toThrow();
    expect(await db.page.findMany()).toEqual(before);
    expect(await db.gscSyncCoverage.count()).toBe(56);
    google.fetchPageAnalytics.mockRejectedValue(new Error("network failed"));
    await expect(sync()).rejects.toThrow("network failed");
    expect(await db.page.findMany()).toEqual(before);
  });
  it("does not replace data when the property changes while fetching", async () => {
    google.fetchPageAnalytics.mockResolvedValue([page(getDataLagDate())]);
    await sync();
    const before = await db.page.findMany();
    const beforeCoverage = await db.gscSyncCoverage.findMany();
    google.fetchPageAnalytics.mockImplementationOnce(async () => {
      await db.site.update({ where: { id: "s" }, data: { gscProperty: "https://example.test/" } });
      return [];
    });
    await expect(sync()).rejects.toThrow("GSC property or ownership changed");
    expect(await db.page.findMany()).toEqual(before);
    expect(await db.gscSyncCoverage.findMany()).toEqual(beforeCoverage);
  });
  it("does not use coverage from a different Search Console property", async () => {
    google.fetchPageAnalytics.mockResolvedValue([page(getDataLagDate(), 20)]);
    google.fetchPropertyAnalytics.mockResolvedValue([page(getDataLagDate(), 12)]);
    await sync();
    await db.site.update({ where: { id: "s" }, data: { gscProperty: "https://example.test/" } });
    expect((await getGscCoverage("s")).comparable).toBe(false);
    expect((await getSitePeriodMetrics("s")).coverage.currentReportedDays).toBe(0);
    expect(await getDailyTraffic("s", 28)).toEqual([]);
  });
  it("invalidates provider rows atomically through the site API and keeps saved keywords on rebind", async () => {
    const date = getDataLagDate(), target = "https://example.test/";
    google.fetchSearchAnalytics.mockResolvedValue([{ ...page(date), query: "guide" }]);
    google.fetchPageAnalytics.mockResolvedValue([page(date)]);
    google.fetchPropertyAnalytics.mockResolvedValue([page(date)]);
    await sync();
    await db.savedKeyword.create({ data: { siteId: "s", query: "guide", notes: "retain" } });
    google.listGSCProperties.mockResolvedValue([{ siteUrl: target, permissionLevel: "siteOwner" }]);
    const context = { params: Promise.resolve({ siteId: "s" }) };
    const response = await updateSite(new Request("http://localhost/api/sites/s", { method: "PUT", body: JSON.stringify({ gscProperty: target }) }), context);
    expect(response.status).toBe(200);
    expect((await db.site.findUniqueOrThrow({ where: { id: "s" } })).gscProperty).toBe(target);
    expect(await Promise.all([db.page.count(), db.keyword.count(), db.queryPage.count(), db.gscSyncCoverage.count()])).toEqual([0, 0, 0, 0]);
    expect((await db.savedKeyword.findFirstOrThrow()).notes).toBe("retain");
    await expect(sync()).rejects.toThrow("GSC property or ownership changed");
    expect(await getTopKeywords("s")).toEqual([]);
  });
  it("returns only verified details while a changed property is partially refreshed", async () => {
    const { current } = gscComparisonWindows();
    const oldDay = new Date(current.start), newDay = new Date(current.end);
    const unknownDay = new Date(oldDay.getTime() + 86_400_000);
    const currentProperty = "https://example.test/";
    await db.site.update({ where: { id: "s" }, data: { gscProperty: currentProperty } });
    await db.gscSyncCoverage.createMany({ data: [
      { siteId: "s", date: oldDay, gscProperty: "sc-domain:example.test", pagesComplete: true, queryPagesComplete: true },
      { siteId: "s", date: newDay, gscProperty: currentProperty, pagesComplete: true, queryPagesComplete: true,
        propertyChecked: true, propertyClicks: 5, propertyImpressions: 30, propertyPosition: 2 },
    ] });
    const rows = [
      { name: "old", date: oldDay, clicks: 90, impressions: 100 },
      { name: "unverified", date: unknownDay, clicks: 89, impressions: 100 },
      { name: "current", date: newDay, clicks: 5, impressions: 30 },
    ];
    for (const { name, ...values } of rows) {
      await db.keyword.create({ data: { siteId: "s", query: name, position: 2, ...values } });
      await db.page.create({ data: { siteId: "s", url: `https://example.test/${name}`, position: 2, ...values } });
    }
    expect((await getSitePeriodMetrics("s")).current.clicks).toBe(5);
    expect(await getTopKeywords("s")).toEqual([{ query: "current", clicks: 5, impressions: 30, position: 2, ctr: 5 / 30 }]);
    expect((await getTopPages("s")).map(row => row.url)).toEqual(["https://example.test/current"]);
    expect(await getTopKeywords("s", 28, 5, ["old", "unverified"])).toEqual([]);
    await db.savedKeyword.createMany({ data: rows.map(row => ({ siteId: "s", query: row.name })) });
    const context = { params: Promise.resolve({ siteId: "s" }) };
    const result = await getSavedKeywords(new Request("http://localhost/api/sites/s/saved-keywords"), context);
    const saved = await result.json();
    expect(saved).toContainEqual(expect.objectContaining({ query: "unverified", latestRank: null }));
    expect(saved).toContainEqual(expect.objectContaining({ query: "current", latestRank: expect.objectContaining({ clicks: 5 }) }));
    expect(await (await getRankHistory(new Request("http://localhost/api/sites/s/rank-history?query=old"), context)).json()).toEqual([]);
  });
  it("ranks zero-click high-impression opportunities across the whole property", async () => {
    const date = new Date(getDataLagDate());
    await db.gscSyncCoverage.create({ data: { siteId: "s", gscProperty: "sc-domain:example.test", date, queryPagesComplete: true } });
    await db.keyword.createMany({ data: [
      ...Array.from({ length: 201 }, (_, i) => ({ siteId: "s", date, query: `popular-${i}`, clicks: 5, impressions: 100, position: 5 })),
      { siteId: "s", date, query: "overlooked", clicks: 0, impressions: 100000, position: 5 },
    ] });
    const opportunities = await getAllOpportunities("s");
    expect(opportunities.lowCtr[0]).toMatchObject({ query: "overlooked", expectedCtr: 0.07, clicks: 0 });
    expect(opportunities.striking[0]).toMatchObject({ query: "overlooked", impressions: 100000 });
  });
  it("does not mix legacy totals into a partially refreshed comparison or fill missing dates with zero", async () => {
    const { current, previous } = gscComparisonWindows();
    for (const start of [current.start, previous.start]) {
      const date = new Date(start);
      await db.gscSyncCoverage.create({ data: { siteId: "s", gscProperty: "sc-domain:example.test", date, pagesComplete: true } });
      await db.page.create({ data: { siteId: "s", date, url: "https://example.test/a", clicks: 99, impressions: 100, position: 8 } });
    }
    await db.gscSyncCoverage.create({ data: { siteId: "s", gscProperty: "sc-domain:example.test", date: new Date(current.end),
      pagesComplete: true, propertyChecked: true, propertyClicks: 0, propertyImpressions: 3, propertyPosition: 2 } });
    const m = await getSitePeriodMetrics("s");
    expect(m).toMatchObject({ basis: "property", current: { clicks: 0, impressions: 3 }, deltas: { clicks: null },
      coverage: { currentReportedDays: 1, previousReportedDays: 0, comparable: false } });
    expect(await getDailyTraffic("s", 56)).toEqual([{ date: current.end, clicks: 0, impressions: 3 }]);
  });
});
