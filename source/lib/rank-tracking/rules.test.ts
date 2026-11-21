import { describe, expect, it } from "vitest";
import { checkEstimateUsd, estimateRankRun, monthlyEstimateUsd, pagesFor } from "./costs";
import {
  DEFAULT_RANK_SETTINGS, finishedRunStatus, keywordsWithinBudget, movementOf, nextCollectDelayMs, ownDomainsOf, parseRankSettings,
  rankDrops, rankSettingsOf, rankSummary, runEstimate, topOf, type CheckView, type RankRow,
} from "./rules";

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected an error");
}

const check = (position: number | null, extra: Partial<CheckView> = {}): CheckView => ({
  position, absolute: position, url: position ? "https://example.com/a" : null, aiOverview: false, aiCited: null, features: [],
  checkedAt: "2026-11-19T08:00:00.000Z", runId: "r1", ...extra,
});

function row(keyword: string, latest: CheckView | null, previous: CheckView | null, tracked = true): RankRow {
  return {
    id: keyword, keyword, tracked, notes: null, latest, previous, ...movementOf(previous, latest), urlChanged: false, failure: null, gsc: null, operator: false,
  };
}

describe("costs", () => {
  it("bills each page of up to ten results, and the AI Overview on top", () => {
    expect([10, 11, 20, 30, 100].map(pagesFor)).toEqual([1, 2, 2, 3, 10]);
    expect(checkEstimateUsd(30, false)).toBe(0.0018);
    expect(checkEstimateUsd(30, true)).toBe(0.0024);
    expect(estimateRankRun(100, 30, false)).toEqual({ tasks: 100, usd: 0.18 });
  });

  it("puts a month of daily checks of 100 keywords at about $5.40", () => {
    expect(monthlyEstimateUsd(100, 30, false, 1)).toBe(5.4);
    expect(monthlyEstimateUsd(100, 30, false, 7)).toBeCloseTo(0.7714, 4);
    expect(monthlyEstimateUsd(100, 30, false, null)).toBeNull();
  });
});

describe("settings", () => {
  it("accepts the offered depths and devices, a schedule and a budget", () => {
    expect(parseRankSettings({ device: "mobile", depth: 50, aiOverview: true, scheduleDays: 7, budgetUsd: 2.346 }))
      .toEqual({ device: "mobile", depth: 50, aiOverview: true, scheduleDays: 7, budgetUsd: 2.35 });
    expect(thrown(() => parseRankSettings({ ...DEFAULT_RANK_SETTINGS, depth: 40 }))).toMatchObject({ name: "ZodError" });
    expect(thrown(() => parseRankSettings({ ...DEFAULT_RANK_SETTINGS, budgetUsd: 0 }))).toMatchObject({ name: "ZodError" });
    expect(thrown(() => parseRankSettings({ ...DEFAULT_RANK_SETTINGS, extra: 1 }))).toMatchObject({ name: "ZodError" });
  });

  it("reads stored settings defensively, with defaults for a site without any", () => {
    expect(rankSettingsOf(null)).toEqual(DEFAULT_RANK_SETTINGS);
    expect(rankSettingsOf({ device: "tablet", depth: 37, aiOverview: true, scheduleDays: 0, budgetUsd: -1 }))
      .toEqual({ device: "desktop", depth: 30, aiOverview: true, scheduleDays: null, budgetUsd: 1 });
  });

  it("checks only as many keywords as the budget covers", () => {
    const settings = { ...DEFAULT_RANK_SETTINGS, budgetUsd: 0.05 };
    // $0.0018 a keyword: 27 fit in $0.05.
    expect(keywordsWithinBudget(100, settings)).toBe(27);
    expect(keywordsWithinBudget(10, settings)).toBe(10);
    expect(runEstimate(100, settings)).toEqual({ tasks: 27, usd: 0.0486, skipped: 73 });
    // Exactly at the budget still fits.
    expect(keywordsWithinBudget(1000, { depth: 10, aiOverview: false, budgetUsd: 0.06 })).toBe(100);
  });
});

describe("movement", () => {
  it("counts places gained as positive and tells entering from leaving", () => {
    expect(movementOf(check(8), check(3))).toEqual({ change: 5, movement: "UP" });
    expect(movementOf(check(3), check(8))).toEqual({ change: -5, movement: "DOWN" });
    expect(movementOf(check(4), check(4))).toEqual({ change: 0, movement: "SAME" });
    expect(movementOf(check(null), check(12))).toEqual({ change: null, movement: "ENTERED" });
    expect(movementOf(check(12), check(null))).toEqual({ change: null, movement: "LEFT" });
    expect(movementOf(check(null), check(null))).toEqual({ change: null, movement: null });
    expect(movementOf(null, check(5))).toEqual({ change: null, movement: null });
  });

  it("summarizes tracked keywords only", () => {
    const rows = [
      row("a", check(2, { aiOverview: true, aiCited: true }), check(4)),
      row("b", check(9), check(5)),
      row("c", check(null), check(15)),
      row("d", check(25, { aiOverview: true, aiCited: false }), null),
      row("e", null, null),
      row("f", check(1), null, false),
    ];
    expect(rankSummary(rows)).toEqual({ tracked: 5, checked: 4, top3: 1, top10: 2, ranked: 3, notRanked: 1, up: 1, down: 2, aiOverview: 2, aiCited: 1 });
  });
});

describe("rankDrops", () => {
  it("reports keywords that fell the threshold or off the first page, worst first", () => {
    const drops = rankDrops([
      { keyword: "small", previous: 3, latest: 4, hadPrevious: true },
      { keyword: "page two", previous: 9, latest: 11, hadPrevious: true },
      { keyword: "five", previous: 20, latest: 25, hadPrevious: true },
      { keyword: "gone", previous: 40, latest: null, hadPrevious: true },
      { keyword: "new", previous: null, latest: 50, hadPrevious: false },
      { keyword: "never", previous: null, latest: null, hadPrevious: true },
      { keyword: "up", previous: 30, latest: 2, hadPrevious: true },
    ], 5);
    expect(drops).toEqual([
      { keyword: "gone", from: 40, to: null },
      { keyword: "five", from: 20, to: 25 },
      { keyword: "page two", from: 9, to: 11 },
    ]);
  });
});

describe("helpers", () => {
  it("normalizes the site's domain and reads stored results defensively", () => {
    expect(ownDomainsOf("https://www.Example.com/")).toEqual(["example.com"]);
    expect(ownDomainsOf("not a domain")).toEqual([]);
    expect(topOf([{ rank: 1, domain: "a.com", url: "https://a.com/", title: "A" }, { rank: "2", domain: "b.com", url: "https://b.com/" }, null]))
      .toEqual([{ rank: 1, domain: "a.com", url: "https://a.com/", title: "A" }]);
    expect(topOf("nope")).toEqual([]);
  });

  it("closes runs by what came back and spaces out collection", () => {
    expect(finishedRunStatus(10, 10, 0)).toBe("SUCCEEDED");
    expect(finishedRunStatus(10, 8, 0)).toBe("PARTIAL");
    expect(finishedRunStatus(10, 9, 1)).toBe("PARTIAL");
    expect(finishedRunStatus(10, 0, 10)).toBe("FAILED");
    expect(nextCollectDelayMs(0)).toBe(60_000);
    expect(nextCollectDelayMs(20 * 60_000)).toBe(5 * 60_000);
    expect(nextCollectDelayMs(10 * 60 * 60_000)).toBe(15 * 60_000);
  });
});
