import { describe, expect, it } from "vitest";
import { formatCitationGaps, formatCrawlIssues, formatRankings, formatSiteOverview, formatOpportunities, formatVitals } from "./formatters";

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

describe("formatVitals", () => {
  const lab = { date: "2026-11-18T08:00:00.000Z", device: "MOBILE", perfScore: 71, lcp: 3.1, cls: 0.02, inp: null, ttfb: 0.8 };
  it("shows lab TBT and the real-user p75, marking whole-site data", () => {
    const out = formatVitals([
      { ...lab, tbt: 420, field: { source: "URL", lcp: 2.4, inp: 180, cls: 0.05, category: "AVERAGE" } },
      { ...lab, device: "DESKTOP", tbt: 90, field: { source: "ORIGIN", lcp: 1.9, inp: null, cls: 0.01, category: "FAST" } },
    ]);
    expect(out).toContain("TBT (lab)");
    expect(out).toContain("420ms");
    expect(out).toContain("2.40s / 180ms / 0.050");
    expect(out).toContain("1.90s / - / 0.010 (origin)");
  });
  it("reads a server without field data or TBT", () => {
    const out = formatVitals([lab]);
    expect(out).toContain("1 vitals reports");
    expect(out).toContain("3.10s");
    expect(out).not.toContain("undefined");
  });
});

describe("formatRankings", () => {
  const base = {
    site: { domain: "kammakhome.com" },
    market: { language: "en", location: 2840 },
    settings: { device: "desktop", depth: 30, aiOverview: true, scheduleDays: 7 },
    summary: { tracked: 3, checked: 2, top3: 1, top10: 1, ranked: 1, notRanked: 1, up: 1, down: 1, aiOverview: 1, aiCited: 0 },
    lastRun: { status: "SUCCEEDED", startedAt: "2026-11-19T08:00:00.000Z", finishedAt: "2026-11-19T08:06:00.000Z", checks: 3, done: 2, failed: 1, costUsd: 0.0072, errorCode: null },
  };
  const keyword = { change: null, movement: null, url: null, urlChanged: false, aiOverview: null, aiCited: null, checkedAt: null, lastCheckFailed: false, gscPosition: null };

  it("shows measured positions with their change next to Search Console's average", () => {
    const out = formatRankings({
      ...base,
      keywords: [
        { ...keyword, keyword: "sofa beds", position: 2, change: 3, movement: "UP", url: "https://kammakhome.com/sofa", urlChanged: true, aiOverview: true, aiCited: false, checkedAt: "2026-11-19T08:05:00.000Z", gscPosition: 4.26 },
        { ...keyword, keyword: "corner sofa", position: null, movement: "LEFT", checkedAt: "2026-11-19T08:05:00.000Z", lastCheckFailed: true },
        { ...keyword, keyword: "new one", position: null },
      ],
    });
    expect(out).toContain("first 30 results, checked every 7 day(s)");
    expect(out).toContain("1 in the top 3, 1 in the top 10, 1 not in the first 30; 1 up and 1 down");
    expect(out).toContain("it cited the site for 0");
    expect(out).toContain("Last run: 2026-11-19 SUCCEEDED, 2/3 checks, $0.0072");
    expect(out).toMatch(/sofa beds\s+\| 2\s+\| \+3\s+\| 4\.3\s+\| \/sofa \(changed\)\s+\| not citing site\s+\| 2026-11-19/);
    expect(out).toMatch(/corner sofa\s+\| >30\s+\| out\s+\| -\s+\| -\s+\| -\s+\| 2026-11-19 \(last check failed\)/);
    expect(out).toMatch(/new one\s+\| not checked/);
  });

  it("says when nothing is tracked", () => {
    expect(formatRankings({ ...base, keywords: [] })).toBe("No keywords are tracked for kammakhome.com. Mark saved keywords for tracking on the Rank tracking page of A-Border SEO.");
  });
});

describe("formatCitationGaps", () => {
  const base = { site: { domain: "kammakhome.com" }, since: "2026-08-21T00:00:00.000Z", brand: "Kammak", competitors: ["Acme"], activePrompts: 4 };

  it("lists cited sites with the prompts and pages behind them", () => {
    const out = formatCitationGaps({
      ...base,
      gaps: [{ domain: "reddit.com", type: "FORUM", gapAnswers: 3, answers: 4, withBrand: 1, competitors: ["Acme"], platforms: ["CHATGPT", "PERPLEXITY"], prompts: ["best sofa brand"], urls: ["https://reddit.com/r/sofas/1"] }],
    });
    expect(out).toContain("Citation gaps for kammakhome.com (brand Kammak; competitors Acme)");
    expect(out).toMatch(/reddit\.com\s+\| forum\s+\| 3\/4\s+\| 1\s+\| Acme\s+\| CHATGPT, PERPLEXITY/);
    expect(out).toContain("  prompt: best sofa brand");
    expect(out).toContain("  cited: https://reddit.com/r/sofas/1");
  });

  it("says when tracking is not set up or no gap was found", () => {
    expect(formatCitationGaps({ ...base, brand: null, gaps: [] })).toMatch(/^Prompt tracking is not set up for kammakhome\.com/);
    expect(formatCitationGaps({ ...base, gaps: [] })).toMatch(/^No citation gaps for kammakhome\.com in the answers since 2026-08-21/);
  });
});
