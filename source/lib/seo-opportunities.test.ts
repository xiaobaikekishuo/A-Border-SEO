import { describe, expect, it, vi } from "vitest";

const { getTopKeywords, getTopPages, getGscCoverage, getOverviewKeywordCandidates } = vi.hoisted(() => ({
  getTopKeywords: vi.fn(),
  getTopPages: vi.fn(),
  getGscCoverage: vi.fn(),
  getOverviewKeywordCandidates: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/gsc-coverage", () => ({ getGscCoverage }));
vi.mock("@/lib/seo-metrics", async importOriginal => ({ ...await importOriginal<typeof import("./seo-metrics")>(), getTopKeywords, getTopPages, getOverviewKeywordCandidates }));

import { csvTextCell, exportKeywordsCsv, exportPagesCsv, getAllOpportunities } from "./seo-opportunities";

const metrics = { position: 4, clicks: 1, impressions: 10, ctr: 0.1 };

it("builds both keyword opportunity lists from one ranked read and checks coverage once", async () => {
  getOverviewKeywordCandidates.mockResolvedValue([{ query: "example", clicks: 1, impressions: 1000, position: 5, ctr: 0.001 }]);
  getGscCoverage.mockResolvedValue({ comparable: false, queryPagesComplete: false });
  const result = await getAllOpportunities("site-1");
  expect(result.striking[0].query).toBe("example");
  expect(result.lowCtr[0].query).toBe("example");
  expect(getOverviewKeywordCandidates).toHaveBeenCalledOnce();
  expect(getGscCoverage).toHaveBeenCalledOnce();
});

describe("csvTextCell", () => {
  it("prefixes an apostrophe to every formula trigger", () => {
    for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvTextCell(`${trigger}1+1`)).toBe(`"'${trigger}1+1"`);
    }
  });

  it("leaves ordinary text alone and still doubles quotes", () => {
    expect(csvTextCell("blue widgets")).toBe('"blue widgets"');
    expect(csvTextCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvTextCell("a-b = c")).toBe('"a-b = c"');
  });
});

describe("CSV exports", () => {
  it("writes a formula-shaped query as text", async () => {
    getTopKeywords.mockResolvedValue([
      { query: '=HYPERLINK("https://example.com","click")', ...metrics },
      { query: "@widgets", ...metrics },
    ]);

    const [, first, second] = (await exportKeywordsCsv("site-1")).split("\n");
    expect(first.startsWith(`"'=HYPERLINK(""https://example.com"",""click"")",`)).toBe(true);
    expect(second.startsWith(`"'@widgets",`)).toBe(true);
  });

  it("writes a formula-shaped URL as text", async () => {
    getTopPages.mockResolvedValue([{ url: "-1+1", ...metrics }]);

    const [, line] = (await exportPagesCsv("site-1")).split("\n");
    expect(line.startsWith(`"'-1+1",`)).toBe(true);
  });
});
