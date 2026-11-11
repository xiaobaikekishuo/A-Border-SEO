
vi.mock("@/lib/i18n/server", async () => {
  const { createTranslator } = await import("@/lib/i18n/shared");
  return { getI18n: async () => ({ locale: "en", t: createTranslator("en") }) };
});
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Review = { excluded: number; unverified: number; message: string };
const state = vi.hoisted(() => ({
  pagesFound: 200,
  maxPages: 200 as number | undefined,
  auditReview: undefined as Review | undefined,
  issues: [] as {
    id: string; severity: string; type: string; url: string; message: string;
    details: { kind?: string; howToFix?: string } | null;
  }[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "test-user" } }) }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findUnique: async () => ({ userId: "test-user", domain: "catalog.example" }) },
    crawl: { findFirst: async () => ({
      id: "test-crawl", pagesFound: state.pagesFound, maxPages: state.maxPages,
      finishedAt: new Date("2026-11-04T08:05:00Z"), healthScore: 100,
    }) },
    auditPage: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/crawler/issue-filter", () => ({
  getVisibleIssues: async () => ({
    issues: state.issues,
    total: state.issues.length,
    bySeverity: { CRITICAL: 0, WARNING: 0, INFO: state.issues.length },
    ...(state.auditReview ? { auditReview: state.auditReview } : {}),
  }),
}));
vi.mock("@/lib/crawler/page-stats", () => ({
  crawledPageColumns: {},
  getCrawlPageStats: async () => ({ pages: state.pagesFound, avgContentScore: 75, orphans: 1, noindex: 0 }),
  getCrawlRobotsReport: async () => null,
}));
vi.mock("@/lib/crawler/noindex-warning", () => ({ getNoindexWarning: async () => null }));
vi.mock("@/lib/jobs/site-jobs", () => ({ getCrawlActivity: async () => ({ active: null, failed: null }) }));
vi.mock("@/components/sites/action-buttons", () => ({ CrawlButton: () => null }));
vi.mock("@/components/sites/crawled-pages-table", () => ({ CrawledPagesTable: () => null }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/sites/test-site/crawl",
}));

import CrawlPage from "./page";

async function render() {
  return renderToString(await CrawlPage({ params: Promise.resolve({ siteId: "test-site" }) }))
    .replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.pagesFound = 200;
  state.maxPages = 200;
  state.auditReview = undefined;
  state.issues = [];
});

describe("audit review notices", () => {
  it("distinguishes sitemap coverage from a missing sitemap file and explains optional pagination metadata", async () => {
    state.issues = [
      { id: "coverage", type: "MISSING_SITEMAP", severity: "INFO", url: "https://catalog.example/products?page=2",
        message: "Crawled page not listed in sitemap", details: { kind: "not_in_sitemap", howToFix: "old advice" } },
      { id: "missing-file", type: "MISSING_SITEMAP", severity: "WARNING", url: "https://catalog.example/",
        message: "Missing sitemap", details: null },
      { id: "description", type: "DUPLICATE_DESCRIPTION", severity: "INFO", url: "https://catalog.example/products",
        message: "Duplicate description", details: { howToFix: "old advice" } },
    ];
    const html = await render();
    expect(html).toContain("SITEMAP COVERAGE");
    expect(html).toContain("MISSING SITEMAP");
    expect(html).toContain("Inclusion is optional");
    expect(html).toContain("Paginated sequences may share descriptions");
    expect(html).not.toContain("old advice");
  });

  it("shows the sample boundary and audit review before interpreting the health score", async () => {
    state.auditReview = {
      excluded: 4,
      unverified: 1,
      message: "4 reviewed false positives excluded; 1 finding unverified and not deducted from health. Original observations are retained.",
    };
    const html = await render();

    expect(html).toContain("Limited crawl sample");
    expect(html).toContain("Reached the 200-page limit");
    expect(html).toContain(state.auditReview.message);
    expect(html.indexOf("Limited crawl sample")).toBeLessThan(html.indexOf(">Health<"));
  });

  it("labels orphan candidates separately from real missing canonical issues", async () => {
    state.issues = [
      { id: "orphan", type: "MISSING_CANONICAL", severity: "INFO", url: "https://catalog.example/cup",
        message: "Potential orphan in a limited crawl", details: { kind: "orphan" } },
      { id: "canonical", type: "MISSING_CANONICAL", severity: "WARNING", url: "https://catalog.example/plate",
        message: "Missing canonical tag", details: null },
    ];
    const html = await render();

    expect(html).toContain("ORPHAN CANDIDATE");
    expect(html).toContain("MISSING CANONICAL");
    expect(html).toMatch(/Potential orphans<\/span><span[^>]*>1</);
    expect(html).not.toContain("Orphans (no inbound link)");
  });

  it("keeps old crawl responses renderable without adding review or sample notices", async () => {
    state.maxPages = undefined;
    const html = await render();

    expect(html).toContain("Crawl / Audit");
    expect(html).not.toContain("Limited crawl sample");
    expect(html).not.toContain("aria-label=\"Audit review\"");
  });

  it("does not claim the configured sample cap was reached when fewer pages were found", async () => {
    state.pagesFound = 199;

    expect(await render()).not.toContain("Limited crawl sample");
  });
});
