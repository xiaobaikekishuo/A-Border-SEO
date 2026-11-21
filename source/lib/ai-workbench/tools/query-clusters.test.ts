import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generationSchemaFor, workbenchRequestSchema, type WorkbenchResult } from "../schema";
import { fitsWorkerClaim } from "./common";
import { clusterFigures, clusterPrompt, reviewClusters, type ClusterContext } from "./query-clusters";

const context: ClusterContext = {
  domain: "shop.test", period: { start: "2026-10-20", end: "2026-11-16" },
  pages: [{ id: "P1", url: "https://shop.test/cases", title: "Cases" }, { id: "P2", url: "https://shop.test/blog/case-care", title: "Case care" }, { id: "P3", url: "https://shop.test/", title: "Home" }],
  queries: [
    { id: "Q1", query: "leather phone case", clicks: 10, impressions: 400, position: 6, pages: [{ page: "P1", impressions: 380, share: 0.95 }, { page: "P3", impressions: 20, share: 0.05 }] },
    { id: "Q2", query: "best leather phone case", clicks: 2, impressions: 200, position: 9, pages: [{ page: "P1", impressions: 100, share: 0.5 }, { page: "P2", impressions: 100, share: 0.5 }] },
    { id: "Q3", query: "how to clean leather case", clicks: 1, impressions: 100, position: 25, pages: [{ page: "P2", impressions: 100, share: 1 }] },
    { id: "Q4", query: "phone case returns", clicks: 0, impressions: 20, position: 12, pages: [] },
  ],
};
const base: WorkbenchResult = { title: "Clusters", summary: "s", contentMarkdown: "c", metaTitle: "m", metaDescription: "d", changeNotes: [], factChecks: ["GSC omits some queries"], internalLinks: [], paragraphEdits: [] };
const cluster = (name: string, queryIds: string[], pageId: string | null) => ({ name, intent: "COMMERCIAL" as const, funnel: "MOFU" as const, queryIds, pageId, note: "n" });

describe("cluster figures", () => {
  it("is covered when the chosen page owns the cluster on page one or two", () => {
    expect(clusterFigures(cluster("Cases", ["Q1"], "P1"), context)).toMatchObject({ status: "COVERED", mismatch: false, impressions: 400, clicks: 10, position: 6,
      ownerUrl: "https://shop.test/cases", chosenUrl: "https://shop.test/cases", pages: [{ url: "https://shop.test/cases", share: 0.95 }, { url: "https://shop.test/", share: 0.05 }] });
  });
  it("is split when two pages each take a fifth of the impressions", () => {
    const review = clusterFigures(cluster("Best cases", ["Q1", "Q2"], "P1"), context);
    expect(review.status).toBe("COVERED");
    const split = clusterFigures(cluster("Best cases", ["Q2"], "P1"), context);
    expect(split.status).toBe("SPLIT");
    expect(split.pages.map(page => page.share)).toEqual([0.5, 0.5]);
    expect(review.position).toBe(7);
  });
  it("is a gap without a fitting page or when it ranks past page two, and flags a page Google prefers", () => {
    expect(clusterFigures(cluster("Returns", ["Q4"], null), context)).toMatchObject({ status: "GAP", chosenUrl: null, ownerUrl: null, pages: [] });
    const deep = clusterFigures(cluster("Cleaning", ["Q3"], "P1"), context);
    expect(deep).toMatchObject({ status: "GAP", mismatch: true, ownerUrl: "https://shop.test/blog/case-care", chosenUrl: "https://shop.test/cases" });
  });
});

describe("cluster results", () => {
  it("puts every query in exactly one cluster and adds the rest to one more", () => {
    const checked = reviewClusters({ ...base, queryClusters: [
      cluster("Cases", ["Q1", "Q2", "Q1"], "P1"),
      cluster("Again", ["Q2", "Q9"], "P7"),
      cluster("Care", ["Q3"], "P2"),
    ] }, context, "zh-CN");
    expect(checked.metaTitle).toBe("");
    expect(checked.queryClusters!.map(c => [c.name, c.queryIds, c.pageId])).toEqual([
      ["Cases", ["Q1", "Q2"], "P1"], ["Care", ["Q3"], "P2"], ["未归类", ["Q4"], null],
    ]);
    expect(checked.clusterReview!.map(r => r.status)).toEqual(["COVERED", "GAP", "GAP"]);
  });
  it("fails when no cluster has a known query", () => {
    let message = "";
    try { reviewClusters({ ...base, queryClusters: [cluster("Nothing", ["Q99"], null)] }, context, "en"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Codex did not group the queries");
  });
  it("builds a prompt that fits a worker claim for two hundred queries", () => {
    const queries = Array.from({ length: 200 }, (_, i) => ({ id: `Q${i + 1}`, query: `leather phone case model ${i} review`, clicks: 3, impressions: 900 - i, position: 8.4,
      pages: [{ page: `P${(i % 60) + 1}`, impressions: 600, share: 0.67 }, { page: `P${((i + 1) % 60) + 1}`, impressions: 300, share: 0.33 }] }));
    const pages = Array.from({ length: 60 }, (_, i) => ({ id: `P${i + 1}`, url: `https://shop.test/products/leather-case-${i}`, title: `Leather case ${i} | Shop` }));
    const input = workbenchRequestSchema.parse({ kind: "QUERY_CLUSTERS", title: "Clusters", language: "en", queryClusters: { limit: 200 } });
    const prompt = clusterPrompt(input, { ...context, queries, pages });
    expect(fitsWorkerClaim(prompt, z.toJSONSchema(generationSchemaFor("QUERY_CLUSTERS"), { target: "draft-7" }))).toBe(true);
  });
});
