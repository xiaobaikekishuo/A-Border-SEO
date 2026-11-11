import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
const google = vi.hoisted(() => ({ fetchSearchAnalytics: vi.fn(), fetchPageAnalytics: vi.fn() }));
vi.mock("@/lib/db", async () => ({ db: (await import("@/lib/testing/pglite")).lazyDb(holder) }));
vi.mock("@/lib/google", async () => ({ ...google, gscDate: (await import("@/lib/google/gsc-date")).gscDate }));
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { getSitePeriodMetrics, getDailyTraffic } from "./seo-metrics";
import { getContentDecay, getCannibalization } from "./seo-opportunities";
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
    const metrics = await getSitePeriodMetrics("s");
    expect(metrics.current.clicks).toBe(5);
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
    expect(metrics.deltas.clicks).toBe(0);
    expect(metrics.deltas.avgPosition).toBeNull();
    expect(await getDailyTraffic("s", 28)).toHaveLength(28);
  });
  it("compares stable daily traffic without an artificial drop", async () => {
    const period = getGscDateRange(56);
    const rows = Array.from({ length: 56 }, (_, i) => page(new Date(new Date(period.start).getTime() + i * 86400000).toISOString().slice(0, 10)));
    google.fetchPageAnalytics.mockResolvedValue(rows);
    await sync();
    const metrics = await getSitePeriodMetrics("s");
    expect(metrics.current.clicks).toBe(28);
    expect(metrics.previous.clicks).toBe(28);
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
    await sync();
    await db.site.update({ where: { id: "s" }, data: { gscProperty: "https://example.test/" } });
    expect((await getGscCoverage("s")).comparable).toBe(false);
  });
});
