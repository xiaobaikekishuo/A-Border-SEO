import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWebsiteUpdate, updateOutcome } from "./update-outcome";

const url = "https://review.example/article";
const now = new Date("2026-11-05T12:00:00Z");
const updateDate = "2026-09-01T12:00:00.000Z";
const baseline = { gscProperty: "sc-domain:review.example", start: "2026-08-01", end: "2026-08-28", clicks: 3, impressions: 30, position: 8 };
function fixture() {
  const cluster = { id: "cluster", url, optimization: { acceptedAt: updateDate, websiteUpdatedAt: null } as Record<string, unknown> };
  const db = {
    site: { findUnique: vi.fn(async () => ({ gscProperty: "sc-domain:review.example" })) },
    gscSyncCoverage: { count: vi.fn(async () => 28) },
    page: { findMany: vi.fn(async (): Promise<{ clicks: number; impressions: number; position: number }[]> => [{ clicks: 4, impressions: 40, position: 7 }]) },
    contentCluster: {
      findFirst: vi.fn(async () => cluster),
      update: vi.fn(async ({ data }: { data: { optimization: Record<string, unknown> } }) => { cluster.optimization = data.optimization; return cluster; }),
    },
  };
  return { db, cluster };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("recorded website update outcomes", () => {
  it("keeps an unreported URL unknown even with complete site coverage", async () => {
    const { db, cluster } = fixture(); db.page.findMany.mockResolvedValue([]);
    await recordWebsiteUpdate(db as never, "site", "cluster", now);
    expect(cluster.optimization.baseline).toBeNull();
    const result = await updateOutcome(db as never, "site", url, { websiteUpdatedAt: updateDate, baseline });
    expect(result?.after).toBeNull();
  });
  it("suppresses the post-update comparison when one reporting day is unsynced", async () => {
    const { db } = fixture(); db.gscSyncCoverage.count.mockResolvedValue(27);
    const result = await updateOutcome(db as never, "site", url, { websiteUpdatedAt: updateDate, baseline });
    expect(result).toMatchObject({ baseline, after: null });
    expect(db.page.findMany).not.toHaveBeenCalled();
  });
  it("does not compare results from a changed GSC property", async () => {
    const { db } = fixture(); db.site.findUnique.mockResolvedValue({ gscProperty: "https://review.example/" });
    const result = await updateOutcome(db as never, "site", url, { websiteUpdatedAt: updateDate, baseline });
    expect(result).toMatchObject({ baseline, after: null });
    expect(db.gscSyncCoverage.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ gscProperty: "https://review.example/" }) }));
  });
  it("records the user-confirmed date and baseline once without resetting them on repeat clicks", async () => {
    const { db, cluster } = fixture();
    expect(await recordWebsiteUpdate(db as never, "site", "cluster", now)).toMatchObject({ alreadyRecorded: false });
    const first = structuredClone(cluster.optimization);
    expect(first).toMatchObject({ websiteUpdatedAt: now.toISOString(), baseline: { gscProperty: baseline.gscProperty, clicks: 4, impressions: 40 } });
    expect(await recordWebsiteUpdate(db as never, "site", "cluster", new Date(now.getTime() + 86400000))).toMatchObject({ alreadyRecorded: true });
    expect(cluster.optimization).toEqual(first);
    expect(db.contentCluster.update).toHaveBeenCalledTimes(1);
    expect(db.page.findMany).toHaveBeenCalledTimes(1);
  });
  it("waits until all 28 post-update dates could have been reported", async () => {
    const { db } = fixture();
    const result = await updateOutcome(db as never, "site", url, { websiteUpdatedAt: "2026-10-20T12:00:00Z", baseline });
    expect(result?.after).toBeNull();
    expect(db.gscSyncCoverage.count).not.toHaveBeenCalled();
  });
  it("uses 28 dates after the recorded day and returns actual comparable totals", async () => {
    const { db } = fixture();
    const result = await updateOutcome(db as never, "site", url, { websiteUpdatedAt: updateDate, baseline });
    expect(result?.after).toEqual({ gscProperty: baseline.gscProperty, start: "2026-09-02", end: "2026-09-29", clicks: 4, impressions: 40, position: 7 });
    expect(db.page.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "site", url, date: { gte: new Date("2026-09-02T00:00:00Z"), lte: new Date("2026-09-29T23:59:59.999Z") } } }));
  });
});
