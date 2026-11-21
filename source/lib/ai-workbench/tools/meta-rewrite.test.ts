import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generationSchemaFor, workbenchRequestSchema, type WorkbenchResult } from "../schema";
import { fitsWorkerClaim } from "./common";
import { benchmarkCtr, containsQuery, lowCtrPages, metaRewritePrompt, reviewMetaRewrites, type MetaContext } from "./meta-rewrite";

const base: WorkbenchResult = { title: "Titles", summary: "s", contentMarkdown: "c", metaTitle: "x", metaDescription: "y", changeNotes: [], factChecks: ["verify"], internalLinks: [{ target: "https://shop.test/", anchor: "a", reason: "r" }], paragraphEdits: [] };
const page = (id: string, url: string, title: string | null, queries: string[]) => ({
  id, url, current: { title, description: "Order custom phone cases online.", h1: "Phone cases" },
  metrics: { clicks: 5, impressions: 1000, ctr: 0.005, position: 4.2, expectedCtr: 0.07 },
  queries: queries.map((query, i) => ({ query, clicks: 1, impressions: 100 - i, position: 4 })),
});
const context: MetaContext = { domain: "shop.test", period: { start: "2026-10-20", end: "2026-11-16" }, withoutData: [], limits: { queriesPerPage: 8 },
  pages: [page("P1", "https://shop.test/cases", "Cases | Shop", ["custom phone case", "iphone 16 case"]), page("P2", "https://shop.test/straps", null, ["watch strap"])] };
const thrown = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as Error).message; } return null; };

describe("meta rewrite candidates", () => {
  it("uses the opportunities page's CTR benchmark", () => {
    expect(benchmarkCtr(1)).toBe(0.28);
    expect(benchmarkCtr(4.2)).toBe(0.07);
    expect(benchmarkCtr(30)).toBe(0.005);
  });
  it("keeps top-20 pages with enough impressions that get fewer clicks than the benchmark, most missed clicks first", () => {
    const pages = lowCtrPages([
      { url: "a", clicks: 2, impressions: 1000, position: 4 }, // 7% expected, 0.2% observed
      { url: "b", clicks: 300, impressions: 1000, position: 1 }, // above the benchmark
      { url: "c", clicks: 0, impressions: 99, position: 2 }, // too few impressions
      { url: "d", clicks: 0, impressions: 5000, position: 25 }, // past page two
      { url: "e", clicks: 0, impressions: 2000, position: 9 }, // 3% of 2,000
      { url: "f", clicks: 0, impressions: 500, position: null },
    ]);
    expect(pages.map(p => p.url)).toEqual(["a", "e"]);
    expect(pages[0]).toMatchObject({ expectedCtr: 0.07, missedClicks: 68 });
  });
  it("matches queries word by word", () => {
    expect(containsQuery("Custom iPhone 16 Phone Case | Shop", "custom phone case")).toBe(true);
    expect(containsQuery("定制手机壳 - 免费设计", "定制手机壳")).toBe(true);
    expect(containsQuery("Phone cases", "custom phone case")).toBe(false);
  });
});

describe("meta rewrite results", () => {
  it("keeps pages and queries it was given, measures length and flags problems", () => {
    const checked = reviewMetaRewrites({ ...base, metaRewrites: [
      { pageId: "P2", title: "Watch Straps in Leather and Steel | Shop", description: "Leather, steel and nylon watch straps for every wrist. Free size guide, easy returns and fitting tips for all popular watches today.", targetQueries: ["Watch Strap", "invented query"], reason: "CTR 0.5% vs 7%" },
      { pageId: "P1", title: "Custom Phone Case for iPhone 16 – 50% Off https://evil.test/x", description: "Design a custom phone case online.", targetQueries: ["custom phone case"], reason: "r" },
      { pageId: "P1", title: "Duplicate id", description: "ignored", targetQueries: ["x"], reason: "r" },
      { pageId: "P9", title: "Unknown page", description: "ignored", targetQueries: ["x"], reason: "r" },
    ] }, context);
    expect(checked.metaTitle).toBe("");
    expect(checked.metaDescription).toBe("");
    expect(checked.internalLinks).toEqual([]);
    const [first, second] = checked.metaRewrites!;
    expect(checked.metaRewrites).toHaveLength(2);
    expect(first.pageId).toBe("P1");
    expect(first.title).toBe("Custom Phone Case for iPhone 16 – 50% Off");
    expect(first.url).toBe("https://shop.test/cases");
    expect(first.currentTitle).toBe("Cases | Shop");
    expect(first.warnings).toEqual(expect.arrayContaining(["URL_REMOVED", "UNSUPPORTED_NUMBER"]));
    expect(first.descriptionStatus).toBe("SHORT");
    expect(first.coveredQueries).toEqual(["custom phone case"]);
    expect(second.targetQueries).toEqual(["watch strap"]);
    expect(second.titleStatus).toBe("OK");
    expect(second.descriptionStatus).toBe("OK");
    expect(second.coveredQueries).toEqual(["watch strap"]);
    expect(second.warnings).toEqual([]);
  });
  it("flags unchanged and duplicate titles, and missing target queries", () => {
    const checked = reviewMetaRewrites({ ...base, metaRewrites: [
      { pageId: "P1", title: "Cases | Shop", description: "Order custom phone cases online with free shipping.", targetQueries: ["nothing given"], reason: "r" },
      { pageId: "P2", title: "cases |  shop", description: "Watch straps.", targetQueries: ["watch strap"], reason: "r" },
    ] }, context);
    expect(checked.metaRewrites![0].warnings).toEqual(expect.arrayContaining(["SAME_AS_CURRENT", "NO_TARGET_QUERY", "DUPLICATE_TITLE"]));
    expect(checked.metaRewrites![1].warnings).toContain("DUPLICATE_TITLE");
  });
  it("fails when no page came back", () => {
    expect(thrown(() => reviewMetaRewrites({ ...base, metaRewrites: [{ pageId: "P7", title: "t", description: "d", targetQueries: ["q"], reason: "r" }] }, context))).toBe("Codex did not return titles for the selected pages");
  });
  it("builds a prompt that fits a worker claim for twenty pages of eight queries", () => {
    const pages = Array.from({ length: 20 }, (_, i) => page(`P${i + 1}`, `https://shop.test/page-${i}`, `Title ${i}`, Array.from({ length: 8 }, (_, q) => `query ${i} ${q} with words`)));
    const input = workbenchRequestSchema.parse({ kind: "META_REWRITE", title: "Titles", language: "en", metaRewrite: { urls: ["https://shop.test/a"] } });
    const prompt = metaRewritePrompt(input, { ...context, pages });
    expect(prompt).toContain("Task: META_REWRITE");
    expect(prompt).toContain("untrusted data");
    expect(fitsWorkerClaim(prompt, z.toJSONSchema(generationSchemaFor("META_REWRITE"), { target: "draft-7" }))).toBe(true);
  });
});
