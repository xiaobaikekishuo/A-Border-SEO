import { describe, expect, it, vi } from "vitest";
import { articleSearchEvidence } from "./article-search-evidence";

function stub(complete: boolean) {
  return {
    site: { findUnique: vi.fn(async () => ({ gscProperty: "sc-domain:review.example" })) },
    gscSyncCoverage: { findMany: vi.fn(async () => Array.from({ length: complete ? 28 : 27 }, () => ({ pagesComplete: true, queryPagesComplete: true }))) },
    page: { findMany: vi.fn(async () => [{ url: "https://review.example/a", clicks: 2, impressions: 12 }]) },
    queryPage: { groupBy: vi.fn(async () => [{ page: "https://review.example/a", query: "guide", _sum: { clicks: 1, impressions: 8 } }]) },
  };
}
describe("article search evidence", () => {
  it("keeps incomplete sync unknown and does not query partial facts", async () => {
    const db = stub(false);
    const result = await articleSearchEvidence(db as never, "site", ["https://review.example/a"], { start: "2026-10-01", end: "2026-10-28" });
    expect(result.pages[0]).toMatchObject({ status: "UNKNOWN", clicks: null, impressions: null, queryStatus: "UNKNOWN", queries: [] });
    expect(db.page.findMany).not.toHaveBeenCalled(); expect(db.queryPage.groupBy).not.toHaveBeenCalled();
  });
  it("supplies actual per-page query samples and leaves unreported URLs unknown", async () => {
    const db = stub(true);
    const result = await articleSearchEvidence(db as never, "site", ["https://review.example/a", "https://review.example/b"], { start: "2026-10-01", end: "2026-10-28" });
    expect(result.pages[0]).toMatchObject({ status: "REPORTED", clicks: 2, impressions: 12, queries: [{ query: "guide", clicks: 1, impressions: 8 }] });
    expect(result.pages[1]).toMatchObject({ status: "NO_RECORDED_ROWS", clicks: null, queryStatus: "NO_RECORDED_ROWS" });
  });
});
