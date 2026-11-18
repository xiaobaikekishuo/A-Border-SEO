import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import type { BingReport } from "@/lib/bing/report";
import { BingReportView } from "./report-view";
import { BingReportChart, chartActiveIndex, chartSegments } from "./report-chart";
import { BingReportTable } from "./report-table";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const report: BingReport = {
  days: 28, startDate: "2026-10-15", endDate: "2026-11-11",
  daily: [
    { date: "2026-11-09", clicks: 0, impressions: 12, crawledPages: 0, inIndex: 5, crawlErrors: 0, blockedByRobots: 0, code4xx: 0, code5xx: 0 },
    { date: "2026-11-10", clicks: null, impressions: null, crawledPages: null, inIndex: null, crawlErrors: null, blockedByRobots: null, code4xx: null, code5xx: null },
    { date: "2026-11-11", clicks: 0, impressions: 8, crawledPages: 2, inIndex: 7, crawlErrors: 0, blockedByRobots: 0, code4xx: 0, code5xx: 0 },
  ],
  totals: { clicks: 0, impressions: 20, ctr: 0, indexedPages: 7, crawledPages: 2, crawlErrors: 0, blockedByRobots: 0 },
  keywords: [{ key: "red shoes", clicks: 0, impressions: 8, ctr: 0, position: 2.5, weeks: 1 }],
  pages: [{ key: "https://example.com/shoes", clicks: null, impressions: 0, ctr: null, position: null, weeks: 1 }],
  coverage: { dailyDays: 2, queryWeeks: 1, pageWeeks: 1 },
  latestDataDate: "2026-11-11", latestSync: { status: "SUCCEEDED", finishedAt: "2026-11-12T06:30:00Z", partial: [], errorCode: null }, hasData: true,
};
const render = (value: BingReport = report, locale: "en" | "zh" = "en") => renderToStaticMarkup(
  <I18nProvider initialLocale={locale}><BingReportView report={value} siteId="site-1" domain="example.com" /></I18nProvider>,
);

describe("Bing chart missing-data semantics", () => {
  it("keeps chart focus inside the replacement range, including 90-day to 28-day navigation", () => {
    expect(chartActiveIndex(89, 90)).toBe(89);
    expect(chartActiveIndex(89, 28)).toBe(27);
    expect(chartActiveIndex(27, 0)).toBeNull();
    expect(chartActiveIndex(null, 28)).toBeNull();
    expect(chartActiveIndex(15, 28)).toBe(15);
    expect(chartActiveIndex(-1, 28)).toBe(0);
  });
  it("breaks a line across missing days while keeping real zeros on the axis", () => {
    const paths = chartSegments([
      { date: "1", value: 4 }, { date: "2", value: 0 }, { date: "3", value: null }, { date: "4", value: 9 },
    ], 10);
    expect(paths).toEqual(["M52.00,112.80 L272.00,172.00", "M712.00,38.80"]);
  });
  it("does not draw a fabricated zero series for a wholly missing metric", () => {
    const html = renderToStaticMarkup(<BingReportChart title="Impressions" description="Daily" points={[
      { date: "2026-11-10", value: null }, { date: "2026-11-11", value: null },
    ]} />);
    expect(html).toContain("No observations in this period");
    expect(html).toContain("Bing has not supplied this metric");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-bing-series");
  });
  it("renders a known zero and keyboard date inspection rather than an empty state", () => {
    const html = renderToStaticMarkup(<BingReportChart title="Clicks" description="Daily" points={[{ date: "2026-11-11", value: 0 }]} />);
    expect(html).toContain("1 reported days");
    expect(html).toContain('cy="172"');
    expect(html).toContain("2026-11-11: 0</title>");
    expect(html).toContain('type="range"');
    expect(html).not.toContain("No observations in this period");
  });
});

describe("Bing report visible meanings", () => {
  it("states the daily coverage, snapshot and weekly boundaries instead of implying complete daily data", () => {
    const html = render();
    expect(html).toContain("2 of 28 calendar days");
    expect(html).toContain("Indexed pages are a snapshot, not a sum");
    expect(html).toContain("weeks whose end date falls in this range");
    expect(html).toContain("Up to 500 rows per dimension");
    expect(html).toContain("0%");
    for (const days of [28, 90, 180]) expect(html).toContain(`/sites/site-1/bing?days=${days}`);
  });
  it("retains unknown counts, zero impressions and undefined CTR as distinct values in weekly rows", () => {
    const html = renderToStaticMarkup(<BingReportTable kind="pages" rows={report.pages} />);
    expect(html).toContain("https://example.com/shoes");
    expect(html).toMatch(/<td[^>]*>Not reported<\/td>/);
    expect(html).toMatch(/<td[^>]*>0<\/td>/);
    expect(html).toMatch(/<td[^>]*>Unavailable<\/td>/);
    expect(html).not.toContain("0%");
  });
  it("keeps stored data visible on a failed sync and gives a recovery message", () => {
    const html = render({ ...report, latestSync: { status: "FAILED", finishedAt: "2026-11-12T06:30:00Z", partial: [], errorCode: "REAUTH_REQUIRED" } });
    expect(html).toContain("Bing authorization needs attention");
    expect(html).toContain("red shoes");
    expect(html).toContain("Daily Bing clicks");
    expect(html).not.toContain("Last sync: completed");
  });
  it("labels partial sync results and never echoes unrecognized provider error fields", () => {
    const html = render({ ...report, latestSync: { ...report.latestSync!, partial: ["queries", "crawl", "unknown-provider-detail"] } });
    expect(html).toContain("partially completed");
    expect(html).toContain("queries, crawl statistics");
    expect(html).not.toContain("unknown-provider-detail");
  });
  it("has a distinct empty-period state, preserves date selection, and never inserts sample data", () => {
    const html = render({ ...report, hasData: false, latestDataDate: null, latestSync: null });
    expect(html).toContain("No Bing data in this period");
    expect(html).toContain("charts stay empty instead of showing zero traffic");
    expect(html).toContain("/sites/site-1/bing?days=180");
    expect(html).toContain("/sites/site-1/settings#bing-connection");
    expect(html).not.toContain("red shoes");
    expect(html).not.toContain("data-bing-series");
  });
  it("provides the same scope and recovery information in Chinese", () => {
    const html = render({ ...report, latestSync: { ...report.latestSync!, partial: ["traffic"] } }, "zh");
    for (const text of ["Bing 点击量", "区间内最近有效快照", "收录数为快照，不按天累加", "关键词", "每日流量", "部分完成", "最多 500 条"]) expect(html).toContain(text);
    expect(html).not.toContain("Daily Bing clicks");
  });
});
