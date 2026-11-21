import { describe, expect, it } from "vitest";
import { evaluateGeoPage, evaluateSiteEntity, factCount, isArticleLike, isFresh, isQuestionHeading, summarizeGeoPages, type GeoPageEvidence } from "./readiness-rules";

const article: GeoPageEvidence = {
  url: "https://shop.example/blogs/news/mug-care", title: "Mug care", description: "How to care for mugs", h1Count: 1, wordCount: 900, internalLinks: 12,
  articleText: "How to clean a ceramic mug. ".repeat(60) + "Use water at 40 °C for 5 minutes. A 350 ml mug weighs 0.4 kg.",
  articleHeadings: ["Mug care", "Daily cleaning", "Is it dishwasher safe?"],
  schemaReport: { version: 2, parsedBlocks: 1, findings: [], entities: [{ types: ["BlogPosting"] }], signals: { author: true, datePublished: true, dateModified: false } },
};

describe("GEO readiness signals", () => {
  it("counts concrete figures, not bare counts", () => {
    expect(factCount("Weighs 1.2 kg, holds 350 ml and costs $19.99. Rated 4.8 by 1,200 buyers in 2026.")).toBe(4);
    expect(factCount("We have 5 more ideas and 3 great tips")).toBe(0);
    expect(factCount("50% off, 3 days left")).toBe(2);
    expect(factCount("容量 350毫升，重 1.2公斤，2026年上市，售价 199元")).toBe(4);
    expect(factCount("第3章 有5个步骤")).toBe(0);
  });
  it("recognizes question headings in English and Chinese", () => {
    for (const heading of ["How do I clean a ceramic mug?", "Is stoneware microwave safe", "陶瓷杯可以进微波炉吗", "如何清洗陶瓷杯"]) expect(isQuestionHeading(heading), heading).toBe(true);
    for (const heading of ["Download our catalog", "Shipping policy", "关于我们"]) expect(isQuestionHeading(heading), heading).toBe(false);
  });
  it("treats blog paths and Article markup as articles", () => {
    expect(isArticleLike("https://shop.example/blogs/news/how-to", null)).toBe(true);
    expect(isArticleLike("https://shop.example/products/mug", null)).toBe(false);
  });
});

describe("page evaluation", () => {
  it("passes a well-prepared article", () => {
    // Without the GEO evidence of newer crawls, freshness, sources and rendering are not judged.
    expect(evaluateGeoPage(article)).toEqual({ SNIPPET: true, HEADING: true, TEXT: true, SECTIONS: true, QUESTIONS: true, FACTS: true, SCHEMA: true, AUTHORSHIP: true, FRESHNESS: null, SOURCES: null, LINKS: true, RENDERING: null });
  });
  it("does not apply article checks to product pages and fails broken markup", () => {
    const product = evaluateGeoPage({ ...article, url: "https://shop.example/products/mug", articleHeadings: ["Mug"], schemaReport: { version: 2, parsedBlocks: 1, findings: [{ severity: "ERROR" }], entities: [{ types: ["Product"] }], signals: {} } });
    expect(product).toMatchObject({ QUESTIONS: null, AUTHORSHIP: null, SECTIONS: false, SCHEMA: false });
  });
  it("leaves checks an older crawl cannot judge out of the score", () => {
    const legacy = evaluateGeoPage({ ...article, articleText: null, articleHeadings: null, schemaReport: { version: 1, parsedBlocks: 1, findings: [], entities: [{ types: ["Article"] }] } });
    expect(legacy).toEqual({ SNIPPET: true, HEADING: true, TEXT: true, SECTIONS: null, QUESTIONS: null, FACTS: null, SCHEMA: true, AUTHORSHIP: null, FRESHNESS: null, SOURCES: null, LINKS: true, RENDERING: null });
    expect(evaluateGeoPage({ ...article, schemaReport: null }).SCHEMA).toBeNull();
  });
  it("judges freshness, cited sources and rendering from the crawl's GEO evidence", () => {
    const asOf = new Date("2026-11-10T00:00:00Z");
    const signals = { version: 1, sourceLinks: 2, sourceHosts: ["who.int"], jsShell: false, jsReason: null, textUnits: 900, published: "2025-01-05", modified: "2026-08-01" };
    expect(evaluateGeoPage({ ...article, geoSignals: signals }, asOf)).toMatchObject({ FRESHNESS: true, SOURCES: true, RENDERING: true });
    const stale = evaluateGeoPage({ ...article, geoSignals: { ...signals, sourceLinks: 0, modified: null, published: "2024-03-01" } }, asOf);
    expect(stale).toMatchObject({ FRESHNESS: false, SOURCES: false });
    // A page without dates is not fresh; a product page is not judged on either.
    expect(evaluateGeoPage({ ...article, geoSignals: { ...signals, published: null, modified: null } }, asOf).FRESHNESS).toBe(false);
    expect(evaluateGeoPage({ ...article, url: "https://shop.example/products/mug", schemaReport: null, geoSignals: signals }, asOf)).toMatchObject({ FRESHNESS: null, SOURCES: null, RENDERING: true });
    expect(evaluateGeoPage({ ...article, geoSignals: { ...signals, jsShell: true, jsReason: "empty_mount" } }, asOf).RENDERING).toBe(false);
    // Evidence in an unknown shape is treated as absent.
    expect(evaluateGeoPage({ ...article, geoSignals: { sourceLinks: "2" } }, asOf).RENDERING).toBeNull();
    expect(isFresh(["2025-11-10"], asOf)).toBe(true);
    expect(isFresh(["2025-11-09"], asOf)).toBe(false);
  });
  it("judges the site entity once from business markup", () => {
    const report = (signals: Record<string, unknown>) => ({ version: 2, parsedBlocks: 1, findings: [], entities: [{ types: ["Organization"] }], signals });
    const pages = [
      { url: "https://shop.example/about", schemaReport: report({ organization: true, organizationLogo: true }) },
      { url: "https://shop.example/", schemaReport: report({ organization: true, organizationLogo: true, organizationSameAs: 3, organizationContact: true }) },
      { url: "https://shop.example/blog/a", schemaReport: report({ organization: false }) },
    ];
    expect(evaluateSiteEntity(pages, true)).toEqual({ status: true, organization: true, logo: true, sameAs: 3, contact: true, url: "https://shop.example/" });
    expect(evaluateSiteEntity(pages.slice(0, 1), true)).toMatchObject({ status: false, logo: true, sameAs: 0, contact: false });
    expect(evaluateSiteEntity([], true)).toMatchObject({ status: false, organization: false, url: null });
    // An older crawl did not record the details.
    expect(evaluateSiteEntity(pages, false).status).toBeNull();
  });
  it("counts Chinese text by character", () => {
    expect(evaluateGeoPage({ ...article, articleText: "我们专注于手工陶瓷。".repeat(30) }).TEXT).toBe(true);
    expect(evaluateGeoPage({ ...article, articleText: "我们专注于手工陶瓷。".repeat(20) }).TEXT).toBe(false);
  });
  it("scores the share of applicable checks passed", () => {
    const results = [evaluateGeoPage(article), evaluateGeoPage({ ...article, title: null, internalLinks: 0, url: "https://shop.example/products/mug", schemaReport: null })];
    const summary = summarizeGeoPages(results);
    const applicable = summary.checks.reduce((sum, check) => sum + check.applicable, 0);
    const passed = summary.checks.reduce((sum, check) => sum + check.passed, 0);
    expect(summary.score).toBe(Math.round((100 * passed) / applicable));
    expect(summary.checks.find(check => check.key === "AUTHORSHIP")).toEqual({ key: "AUTHORSHIP", passed: 1, applicable: 1 });
    expect(summarizeGeoPages([]).score).toBeNull();
  });
});
