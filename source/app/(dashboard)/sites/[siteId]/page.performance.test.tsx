import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, db, countVisibleIssues, getNoindexWarning, getCrawlActivity, getAllOpportunities } = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    site: { findUnique: vi.fn() },
    keyword: { findFirst: vi.fn() },
    page: { findFirst: vi.fn() },
    crawl: { findFirst: vi.fn() },
    auditPage: { count: vi.fn() },
    vitalsReport: { findFirst: vi.fn() },
  },
  countVisibleIssues: vi.fn(),
  getNoindexWarning: vi.fn(),
  getCrawlActivity: vi.fn(),
  getAllOpportunities: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/crawler/issue-filter", () => ({ countVisibleIssues }));
vi.mock("@/lib/crawler/noindex-warning", () => ({ getNoindexWarning }));
vi.mock("@/lib/jobs/site-jobs", () => ({ getCrawlActivity }));
vi.mock("@/lib/seo-opportunities", () => ({ getAllOpportunities }));
vi.mock("@/lib/i18n/server", async () => {
  const { createTranslator } = await import("@/lib/i18n/shared");
  return { getI18n: async () => ({ t: createTranslator("en") }) };
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
}));

const { default: SiteOverviewPage } = await import("./page");
const site = { userId: "owner", domain: "example.test", gscProperty: "sc-domain:example.test", gscSyncCoverage: [] };
const crawl = { id: "crawl", healthScore: 90, healthScoreVersion: 1, finishedAt: new Date("2026-11-01T00:00:00Z") };
const renderPage = () => SiteOverviewPage({ params: Promise.resolve({ siteId: "site" }) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ user: { id: "owner" } });
  db.site.findUnique.mockResolvedValue(site);
  db.keyword.findFirst.mockResolvedValue({ id: "keyword" });
  db.page.findFirst.mockResolvedValue({ id: "page" });
  db.crawl.findFirst.mockResolvedValue(crawl);
  db.auditPage.count.mockResolvedValue(20);
  db.vitalsReport.findFirst.mockResolvedValue(null);
  countVisibleIssues.mockResolvedValue(3);
  getNoindexWarning.mockResolvedValue(null);
  getCrawlActivity.mockResolvedValue({ active: null, failed: null });
  getAllOpportunities.mockResolvedValue({ feed: [] });
});

describe("overview read scheduling", () => {
  it("starts independent reads after ownership, and crawl details before other slow reads finish", async () => {
    const ownership = deferred<typeof site>();
    const latest = deferred<typeof crawl>();
    const vital = deferred<null>();
    const opportunities = deferred<{ feed: never[] }>();
    const issues = deferred<number>();
    db.site.findUnique.mockReturnValue(ownership.promise);
    db.crawl.findFirst.mockReturnValue(latest.promise);
    db.vitalsReport.findFirst.mockReturnValue(vital.promise);
    getAllOpportunities.mockReturnValue(opportunities.promise);
    countVisibleIssues.mockReturnValue(issues.promise);

    const page = renderPage();
    await vi.waitFor(() => expect(db.site.findUnique).toHaveBeenCalledOnce());
    expect(db.crawl.findFirst).not.toHaveBeenCalled();
    expect(db.vitalsReport.findFirst).not.toHaveBeenCalled();
    expect(getAllOpportunities).not.toHaveBeenCalled();
    expect(db.keyword.findFirst).not.toHaveBeenCalled();

    ownership.resolve(site);
    await vi.waitFor(() => expect(db.crawl.findFirst).toHaveBeenCalledOnce());
    expect(db.vitalsReport.findFirst).toHaveBeenCalledOnce();
    expect(getAllOpportunities).toHaveBeenCalledOnce();
    expect(countVisibleIssues).not.toHaveBeenCalled();

    latest.resolve(crawl);
    await vi.waitFor(() => expect(countVisibleIssues).toHaveBeenCalledWith(db, "crawl"));
    expect(db.auditPage.count).toHaveBeenCalledWith({ where: { crawlId: "crawl" } });
    expect(getNoindexWarning).toHaveBeenCalledWith(db, "crawl");
    expect(getCrawlActivity).toHaveBeenCalledWith(db, "site", crawl.finishedAt);

    issues.resolve(3);
    vital.resolve(null);
    opportunities.resolve({ feed: [] });
    await expect(page).resolves.toBeTruthy();
  });

  it.each([null, { ...site, userId: "another-owner" }])("does not start overview reads for an inaccessible site", async inaccessibleSite => {
    db.site.findUnique.mockResolvedValue(inaccessibleSite);
    await expect(renderPage()).rejects.toThrow("REDIRECT /sites");
    expect(db.crawl.findFirst).not.toHaveBeenCalled();
    expect(db.vitalsReport.findFirst).not.toHaveBeenCalled();
    expect(getAllOpportunities).not.toHaveBeenCalled();
    expect(getCrawlActivity).not.toHaveBeenCalled();
    expect(db.keyword.findFirst).not.toHaveBeenCalled();
  });

  it("asks for one stored row instead of counting them all", async () => {
    await expect(renderPage()).resolves.toBeTruthy();
    expect(db.keyword.findFirst).toHaveBeenCalledWith({ where: { siteId: "site" }, select: { id: true } });
    expect(db.page.findFirst).toHaveBeenCalledWith({ where: { siteId: "site" }, select: { id: true } });
    expect(db.site.findUnique.mock.calls[0][0].select).not.toHaveProperty("_count");
  });

  it("skips unavailable history but still checks a pending crawl", async () => {
    db.keyword.findFirst.mockResolvedValue(null);
    db.page.findFirst.mockResolvedValue(null);
    db.crawl.findFirst.mockResolvedValue(null);
    await expect(renderPage()).resolves.toBeTruthy();
    expect(getAllOpportunities).not.toHaveBeenCalled();
    expect(countVisibleIssues).not.toHaveBeenCalled();
    expect(db.auditPage.count).not.toHaveBeenCalled();
    expect(getNoindexWarning).not.toHaveBeenCalled();
    expect(getCrawlActivity).toHaveBeenCalledWith(db, "site", null);
  });

  it("does not hide a failed independent read behind partial statistics", async () => {
    getAllOpportunities.mockRejectedValue(new Error("read failed"));
    await expect(renderPage()).rejects.toThrow("read failed");
  });
});
