import { describe, expect, it } from "vitest";
import { formatCrawlIssues, formatCrawls, formatSiteOverview } from "./formatters";

const crawl = {
  id: "sample-crawl",
  status: "COMPLETED",
  startedAt: "2026-11-04T08:00:00Z",
  finishedAt: "2026-11-04T08:05:00Z",
  pagesFound: 200,
  issuesFound: 1,
  healthScore: 97,
};
const auditReview = {
  excluded: 4,
  unverified: 1,
  message: "4 reviewed false positives excluded; 1 finding unverified and not deducted from health. Original observations are retained.",
};
const issue = {
  severity: "INFO",
  type: "ORPHAN_CANDIDATE",
  url: "https://catalog.example/product",
  message: "Potential orphan in a limited crawl",
};

describe("crawl coverage in MCP output", () => {
  it("shows sample limits and review context even when the issue list is empty", () => {
    const output = formatCrawlIssues({
      crawl: { ...crawl, maxPages: 200 },
      total: 0,
      bySeverity: {},
      issues: [],
      auditReview,
    });

    expect(output).toContain("Limited crawl sample: reached the 200-page limit");
    expect(output).toContain("potential orphan pages may have inbound links outside it");
    expect(output).toContain(`Audit review: ${auditReview.message}`);
    expect(output.indexOf("Audit review:")).toBeLessThan(output.indexOf("No crawl issues found."));
  });

  it("keeps the unverified finding visible with its distinct orphan type", () => {
    const output = formatCrawlIssues({
      crawl: { ...crawl, maxPages: 200 },
      total: 1,
      bySeverity: { INFO: 1 },
      issues: [issue],
      auditReview,
    });

    expect(output).toContain("1 issues: 0 critical, 0 warning, 1 info");
    expect(output).toContain("ORPHAN_CANDIDATE");
    expect(output).not.toContain("MISSING_CANONICAL");
  });

  it.each([199, 200, 201])("reports the configured cap correctly for %s pages", (pagesFound) => {
    const output = formatSiteOverview({
      id: "site-a", domain: "catalog.example", latestCrawl: { ...crawl, pagesFound, maxPages: 200 },
    });

    expect(output.includes("Limited crawl sample:")).toBe(pagesFound >= 200);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not infer a sample limit from an absent or invalid maxPages=%s",
    (maxPages) => {
      const output = formatCrawlIssues({
        crawl: { ...crawl, maxPages }, total: 0, bySeverity: {}, issues: [],
      });

      expect(output).not.toContain("Limited crawl sample:");
      expect(output).not.toContain("Audit review:");
    },
  );

  it("adds review context to site overview from the crawl or the top-level response", () => {
    const site = { id: "site-a", domain: "catalog.example" };
    const nested = formatSiteOverview({ ...site, latestCrawl: { ...crawl, auditReview } });
    const topLevel = formatSiteOverview({ ...site, latestCrawl: crawl, auditReview });

    expect(nested).toContain(`Audit review: ${auditReview.message}`);
    expect(topLevel).toContain(`Audit review: ${auditReview.message}`);
  });

  it("labels the limited crawl in a mixed history and preserves failure explanations", () => {
    const output = formatCrawls([
      { ...crawl, maxPages: 200 },
      { ...crawl, id: "small-crawl", pagesFound: 15, maxPages: 200 },
      { ...crawl, id: "failed-crawl", status: "FAILED", pagesFound: 2, error: "Fetch interrupted" },
    ]);

    expect(output).toContain("sample-crawl: Limited crawl sample:");
    expect(output).not.toContain("small-crawl: Limited crawl sample:");
    expect(output).toContain("failed-crawl: Fetch interrupted");
  });

  it("does not invent review notices for an old response or an empty review", () => {
    const old = formatSiteOverview({ id: "site-a", domain: "catalog.example", latestCrawl: crawl });
    const empty = formatCrawlIssues({
      crawl, total: 0, bySeverity: {}, issues: [],
      auditReview: { excluded: 0, unverified: 0, message: "No review changes" },
    });

    expect(old).not.toContain("Limited crawl sample:");
    expect(old).not.toContain("Audit review:");
    expect(empty).not.toContain("Audit review:");
  });
});
