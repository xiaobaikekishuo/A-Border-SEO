import { describe, expect, it } from "vitest";
import { formatCrawlIssues, formatSiteOverview, formatOpportunities } from "./formatters";

const crawl = {
  id: "c1",
  status: "COMPLETED",
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: "2026-10-25T10:05:00.000Z",
  pagesFound: 12,
  issuesFound: 0,
  healthScore: 100,
  error: null,
};

describe("formatCrawlIssues noindex line", () => {
  it("says how many noindex pages were kept out of the score", () => {
    const out = formatCrawlIssues({ crawl, total: 0, bySeverity: {}, noindexPages: 3, issues: [] });
    expect(out).toContain("3 noindex pages crawled but not scored");
  });

  it("says nothing when there were none, or the instance predates the count", () => {
    expect(formatCrawlIssues({ crawl, total: 0, bySeverity: {}, noindexPages: 0, issues: [] })).not.toContain("noindex");
    expect(formatCrawlIssues({ crawl, total: 0, bySeverity: {}, issues: [] })).not.toContain("noindex");
  });
});

describe("formatCrawlIssues site-wide noindex warning", () => {
  const message = "9 of 10 pages are noindex. If that is not intended, search engines will drop them.";

  it("prints the warning above the counts when the instance sends one", () => {
    const out = formatCrawlIssues({ crawl, total: 0, bySeverity: {}, noindexPages: 9, noindexWarning: { message }, issues: [] });
    expect(out).toContain(`WARNING: ${message}`);
    expect(out.indexOf("WARNING")).toBeLessThan(out.indexOf("9 noindex pages crawled"));
  });

  it("prints nothing for null or an instance without the field", () => {
    expect(formatCrawlIssues({ crawl, total: 0, bySeverity: {}, noindexPages: 1, noindexWarning: null, issues: [] })).not.toContain("WARNING");
    expect(formatCrawlIssues({ crawl, total: 0, bySeverity: {}, noindexPages: 1, issues: [] })).not.toContain("WARNING");
  });
});


describe("incomplete GSC metrics", () => {
  it("renders nullable deltas and explicit coverage without invented improvement", () => {
    const result = formatSiteOverview({ id: "s", domain: "example.test", metrics: {
      current: { clicks: 5, impressions: 130, avgPosition: 7.2, avgCtr: 5 / 130, uniqueKeywords: 2 },
      deltas: { clicks: null, impressions: null, avgPosition: null, avgCtr: null },
      coverage: { comparable: false, current: { start: "2026-10-05", end: "2026-11-01" }, previous: { start: "2026-09-07", end: "2026-10-04" }, currentDays: 0, previousDays: 0, expectedDays: 28 },
    } });
    expect(result).toContain("Avg Position: 7.2 (not comparable)");
    expect(result).toContain("Insufficient synced history");
    expect(result).toContain("2026-10-05 to 2026-11-01");
    expect(result).not.toMatch(/null%|100%|-7.2 improvement/);
  });
  it("does not turn unavailable decay or competition into zero findings", () => {
    const result = formatOpportunities({ coverage: { comparable: false, queryPagesComplete: false }, summary: { strikingDistance: 0, lowCtr: 0, contentDecay: 0, cannibalization: 0 } });
    expect(result).toContain("Content decay: insufficient data");
    expect(result).toContain("Multi-page queries: insufficient data");
  });
});
