import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bingDaily: { findMany: vi.fn(), aggregate: vi.fn() },
  bingSearchWeekly: { findMany: vi.fn(), aggregate: vi.fn() },
  job: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db }));

import { getBingReport, type BingReportDays } from "./report";

const now = new Date("2026-11-12T15:30:00Z");
const daily = (date: string, overrides: Record<string, number | null> = {}) => ({
  date: new Date(date), clicks: null, impressions: null, crawledPages: null, inIndex: null,
  crawlErrors: null, blockedByRobots: null, code4xx: null, code5xx: null, ...overrides,
});
const weekly = (key: string, date: string, overrides: Record<string, string | number | null> = {}) => ({
  key, kind: "query", weekEnding: new Date(date), clicks: 1, impressions: 10, avgImpressionPosition: 5, ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((queries: unknown[]) => Promise.all(queries));
  db.bingDaily.findMany.mockResolvedValue([]);
  db.bingSearchWeekly.findMany.mockResolvedValue([]);
  db.bingDaily.aggregate.mockResolvedValue({ _max: { date: null } });
  db.bingSearchWeekly.aggregate.mockResolvedValue({ _max: { weekEnding: null } });
  db.job.findFirst.mockResolvedValue(null);
});

describe("Bing report date boundaries and isolation", () => {
  it.each([28, 90, 180] as const)("returns %i complete UTC days ending yesterday, with genuine null gaps", async days => {
    const result = await getBingReport("site-a", days, now);
    expect(result.daily).toHaveLength(days);
    expect(result.daily.at(-1)?.date).toBe("2026-11-11");
    expect(result.startDate).toBe(result.daily[0].date);
    expect(result.endDate).toBe(result.daily.at(-1)?.date);
    expect(result.daily.every(row => row.clicks === null && row.impressions === null && row.inIndex === null)).toBe(true);
    expect(result.totals).toEqual({ clicks: null, impressions: null, ctr: null, indexedPages: null,
      crawledPages: null, crawlErrors: null, blockedByRobots: null });
    expect(result.hasData).toBe(false);
    expect(result.latestDataDate).toBeNull();
    expect(result.coverage).toEqual({ dailyDays: 0, queryWeeks: 0, pageWeeks: 0 });
  });

  it("uses UTC across timezone and month boundaries and scopes every query to the selected site", async () => {
    const result = await getBingReport("private-site", 28, new Date("2026-03-01T00:30:00+14:00"));
    const range = { gte: new Date("2026-01-31T00:00:00Z"), lt: new Date("2026-02-28T00:00:00Z") };
    expect(result.startDate).toBe("2026-01-31");
    expect(result.endDate).toBe("2026-02-27");
    expect(db.bingDaily.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "private-site", date: range } }));
    expect(db.bingSearchWeekly.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "private-site", kind: { in: ["query", "page"] }, weekEnding: range },
    }));
    expect(db.bingDaily.aggregate).toHaveBeenCalledWith({ where: { siteId: "private-site" }, _max: { date: true } });
    expect(db.bingSearchWeekly.aggregate).toHaveBeenCalledWith({ where: { siteId: "private-site", kind: { in: ["query", "page"] } }, _max: { weekEnding: true } });
    expect(db.job.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "private-site", type: "bing-sync" } }));
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Array), { isolationLevel: "RepeatableRead" });
  });

  it("rejects malformed dates and unsupported intervals before reading data", async () => {
    await expect(getBingReport("site", 999 as BingReportDays, now)).rejects.toThrow("Invalid Bing report period");
    await expect(getBingReport("site", 28, new Date("invalid"))).rejects.toThrow("Invalid Bing report period");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("keeps latest stored data visible even when the current period is empty", async () => {
    db.bingDaily.aggregate.mockResolvedValue({ _max: { date: new Date("2026-02-01") } });
    db.bingSearchWeekly.aggregate.mockResolvedValue({ _max: { weekEnding: new Date("2026-02-06") } });
    const result = await getBingReport("site", 28, now);
    expect(result.latestDataDate).toBe("2026-02-06");
    expect(result.hasData).toBe(false);
  });
});

describe("Bing report metrics", () => {
  it("adds reported activity, calculates weighted CTR, and uses the latest nonempty index snapshot", async () => {
    db.bingDaily.findMany.mockResolvedValue([
      daily("2026-11-09", { clicks: 3, impressions: 30, inIndex: 80, crawledPages: 3, crawlErrors: 1, blockedByRobots: 0 }),
      daily("2026-11-10", { clicks: 4, impressions: 70, inIndex: 90, crawledPages: 5, crawlErrors: 2, blockedByRobots: 1 }),
      daily("2026-11-11", { clicks: 0, impressions: 0, inIndex: null, crawledPages: 0, crawlErrors: 0, blockedByRobots: 0 }),
    ]);
    const result = await getBingReport("site", 28, now);
    expect(result.totals).toEqual({ clicks: 7, impressions: 100, ctr: 0.07, indexedPages: 90,
      crawledPages: 8, crawlErrors: 3, blockedByRobots: 1 });
    expect(result.coverage.dailyDays).toBe(3);
    expect(result.daily[0].clicks).toBeNull();
    expect(result.daily.at(-1)?.clicks).toBe(0);
    expect(result.hasData).toBe(true);
  });

  it("preserves observed zeros while leaving an undefined CTR and unknown crawl measures empty", async () => {
    db.bingDaily.findMany.mockResolvedValue([daily("2026-11-11", { clicks: 0, impressions: 0, inIndex: 0, crawlErrors: 0 })]);
    const result = await getBingReport("site", 28, now);
    expect(result.totals).toMatchObject({ clicks: 0, impressions: 0, ctr: null, indexedPages: 0, crawlErrors: 0, crawledPages: null });
  });

  it("does not combine mismatched metric coverage into a fabricated total or CTR", async () => {
    db.bingDaily.findMany.mockResolvedValue([
      daily("2026-11-10", { clicks: 7, impressions: null, crawledPages: 5 }),
      daily("2026-11-11", { clicks: null, impressions: 100, crawledPages: 3 }),
    ]);
    const result = await getBingReport("site", 28, now);
    expect(result.totals).toMatchObject({ clicks: null, impressions: null, ctr: null, crawledPages: 8 });
    expect(result.daily.at(-2)?.clicks).toBe(7);
    expect(result.daily.at(-1)?.impressions).toBe(100);
  });

  it("does not display invalid negative or nonfinite counters as measurements", async () => {
    db.bingDaily.findMany.mockResolvedValue([daily("2026-11-11", { clicks: -1, impressions: Infinity, inIndex: -1, code5xx: -9 })]);
    const result = await getBingReport("site", 28, now);
    expect(result.daily.at(-1)).toMatchObject({ clicks: null, impressions: null, inIndex: null, code5xx: null });
    expect(result.totals.clicks).toBeNull();
  });

  it("weights weekly ranks by valid positive impressions and keeps query and page totals separate", async () => {
    db.bingSearchWeekly.findMany.mockResolvedValue([
      weekly("glass", "2026-10-16", { clicks: 10, impressions: 100, avgImpressionPosition: 4 }),
      weekly("glass", "2026-10-23", { clicks: 30, impressions: 300, avgImpressionPosition: 10 }),
      weekly("glass", "2026-10-30", { clicks: 0, impressions: 0, avgImpressionPosition: 100 }),
      weekly("glass", "2026-11-06", { clicks: 0, impressions: 0, avgImpressionPosition: -1 }),
      weekly("https://example.test/", "2026-11-06", { kind: "page", clicks: 1, impressions: 10, avgImpressionPosition: 2 }),
    ]);
    const result = await getBingReport("site", 28, now);
    expect(result.keywords).toEqual([{ key: "glass", clicks: 40, impressions: 400, ctr: 0.1, position: 8.5, weeks: 4 }]);
    expect(result.pages).toEqual([{ key: "https://example.test/", clicks: 1, impressions: 10, ctr: 0.1, position: 2, weeks: 1 }]);
    expect(result.coverage).toEqual({ dailyDays: 0, queryWeeks: 4, pageWeeks: 1 });
    expect(result.totals.clicks).toBeNull();
    expect(result.hasData).toBe(true);
  });

  it("does not give missing or zero impressions a synthetic ranking weight", async () => {
    db.bingSearchWeekly.findMany.mockResolvedValue([
      weekly("partial", "2026-10-16", { clicks: 1, impressions: null, avgImpressionPosition: 100 }),
      weekly("partial", "2026-10-23", { clicks: null, impressions: 10, avgImpressionPosition: 3 }),
      weekly("unknown", "2026-10-23", { impressions: 0, avgImpressionPosition: 100 }),
      weekly("invalid", "2026-10-23", { impressions: 100, avgImpressionPosition: Infinity }),
    ]);
    const result = await getBingReport("site", 28, now);
    expect(result.keywords.find(row => row.key === "partial")).toMatchObject({ clicks: null, impressions: null, ctr: null, position: 3 });
    expect(result.keywords.find(row => row.key === "unknown")?.position).toBeNull();
    expect(result.keywords.find(row => row.key === "invalid")?.position).toBeNull();
  });

  it("caps top tables after aggregation without reducing distinct-week coverage", async () => {
    db.bingSearchWeekly.findMany.mockResolvedValue([
      ...Array.from({ length: 501 }, (_, i) => weekly(`query-${i}`, "2026-10-16", { clicks: i + 1 })),
      weekly("omitted-week", "2026-11-06", { clicks: null }),
    ]);
    const result = await getBingReport("site", 28, now);
    expect(result.keywords).toHaveLength(500);
    expect(result.keywords[0].key).toBe("query-500");
    expect(result.keywords.some(row => row.key === "omitted-week")).toBe(false);
    expect(result.coverage.queryWeeks).toBe(2);
  });
});

describe("Bing sync report metadata", () => {
  it("returns fixed status and whitelisted metadata without exposing raw errors or unrelated result properties", async () => {
    db.job.findFirst.mockResolvedValue({ status: "FAILED", finishedAt: new Date("2026-11-12T04:00:00Z"),
      errorCode: "SECRET_NOT_A_CODE", result: { partial: ["traffic", "pages", "traffic", "unsafe-token", 42], secret: "not-for-ui" }, lastError: "not-for-ui" });
    const result = await getBingReport("site", 28, now);
    expect(result.latestSync).toEqual({ status: "FAILED", finishedAt: "2026-11-12T04:00:00.000Z", errorCode: null, partial: ["traffic", "pages"] });
    expect(JSON.stringify(result)).not.toContain("not-for-ui");
    expect(JSON.stringify(result)).not.toContain("unsafe-token");
    expect(db.job.findFirst.mock.calls[0][0].select).not.toHaveProperty("lastError");
  });

  it("retains actionable missing-key errors and handles an unfinished job", async () => {
    db.job.findFirst.mockResolvedValue({ status: "QUEUED", finishedAt: null, result: null, errorCode: "KEY_MISSING" });
    expect((await getBingReport("site", 28, now)).latestSync).toEqual({ status: "QUEUED", finishedAt: null, partial: [], errorCode: "KEY_MISSING" });
  });
});
