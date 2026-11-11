import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runContentAction } from "./data";
import { getImportablePages } from "./pages";
import { examplePlan } from "./test-fixtures";

let testDb: TestDb;
let db: PrismaClient;
const userId = "bulk-owner";
const siteId = "bulk-site";
let pillarId: string;
let foreignPillarId: string;

beforeAll(async () => {
  testDb = await createTestDb(); db = testDb.db;
  await db.user.createMany({ data: [{ id: userId, email: "bulk@catalog.example" }, { id: "foreign-owner", email: "foreign@catalog.example" }] });
  await db.site.createMany({ data: [{ id: siteId, userId, domain: "catalog.example" }, { id: "foreign-site", userId: "foreign-owner", domain: "foreign.example" }] });
}, 120_000);
afterAll(async () => { await testDb?.close(); });
beforeEach(async () => {
  await db.contentPillar.deleteMany();
  await db.crawl.deleteMany();
  pillarId = (await db.contentPillar.create({ data: { siteId, title: "Guides", keyword: "guide" } })).id;
  foreignPillarId = (await db.contentPillar.create({ data: { siteId: "foreign-site", title: "Foreign", keyword: "foreign" } })).id;
  await db.crawl.createMany({ data: [
    { id: "latest", siteId, status: "COMPLETED", finishedAt: new Date("2026-11-03T10:00:00Z"), pagesFound: 200, maxPages: 200 },
    { id: "older", siteId, status: "COMPLETED", finishedAt: new Date("2026-11-02T10:00:00Z") },
    { id: "unfinished", siteId, status: "RUNNING", startedAt: new Date("2026-11-04T10:00:00Z") },
    { id: "foreign-crawl", siteId: "foreign-site", status: "COMPLETED", finishedAt: new Date("2026-11-04T10:00:00Z") },
  ] });
});
function page(id: string, overrides: Partial<Prisma.AuditPageUncheckedCreateInput> = {}) {
  return db.auditPage.create({ data: { id, crawlId: "latest", url: `https://catalog.example/blog/${id}`, statusCode: 200, title: `Guide ${id}`, wordCount: 500, ...overrides } });
}
function item(pageId: string, keyword = `keyword ${pageId}`) {
  return { pageId, title: `Edited ${pageId}`, keyword, funnel: "MOFU" };
}
function importPages(items: ReturnType<typeof item>[], target = pillarId) {
  return runContentAction(db, userId, siteId, { action: "importPages", pillarId: target, items });
}
function cluster(keyword: string, overrides: Partial<Prisma.ContentClusterUncheckedCreateInput> = {}) {
  return db.contentCluster.create({ data: { siteId, pillarId, title: `Existing ${keyword}`, keyword, dedupeKey: keyword, funnel: "TOFU", ...overrides } });
}
function update(clusterIds: string[], data: Record<string, unknown>) {
  return runContentAction(db, userId, siteId, { action: "bulkUpdateClusters", clusterIds, data });
}

describe("latest crawl page inventory", () => {
  it("requires ownership and returns a useful empty state when no completed crawl exists", async () => {
    await expect(getImportablePages(db, "", siteId, {})).rejects.toMatchObject({ status: 401 });
    await expect(getImportablePages(db, "foreign-owner", siteId, {})).rejects.toMatchObject({ status: 404 });
    await db.crawl.deleteMany({ where: { siteId, status: "COMPLETED" } });
    expect(await getImportablePages(db, userId, siteId, {})).toEqual({ siteId, crawl: null, rows: [], total: 0, page: 1, pageSize: 25 });
  });

  it("uses only the latest completed crawl, excludes non-HTML and foreign evidence, and labels capped samples", async () => {
    await page("zeta");
    await page("alpha", { title: null, h1s: ["Alpha tutorial"], wordCount: 0 });
    await page("product", { url: "https://catalog.example/products/how-to-cup", h1s: ["How to choose a cup"] });
    await page("old", { crawlId: "older" });
    await page("running", { crawlId: "unfinished" });
    await page("foreign-crawl-page", { crawlId: "foreign-crawl" });
    await page("foreign-url", { url: "https://foreign.example/blog/foreign" });
    await page("asset", { url: "https://catalog.example/blog/guide.PDF" });
    await page("redirect", { statusCode: 302 });
    await page("empty", { title: null, wordCount: 0 });
    const result = await getImportablePages(db, userId, siteId, {});
    expect(result.crawl).toEqual({ id: "latest", finishedAt: "2026-11-03T10:00:00.000Z", pagesFound: 200, maxPages: 200, sampleLimited: true });
    expect(result.rows.map((row) => row.id)).toEqual(["alpha", "zeta", "product"]);
    expect(result.rows[0]).toMatchObject({ title: "Alpha tutorial", suggestedKeyword: "Alpha tutorial", articleCandidate: true });
    expect(result.rows[2].articleCandidate).toBe(false);
    expect(result.total).toBe(3);
  });

  it("searches titles and URLs, paginates stable URL order, filters article hints, and annotates other pillars", async () => {
    await page("charlie", { title: "Choose a cup" }); await page("alpha"); await page("bravo");
    await page("help", { url: "https://catalog.example/help", h1s: ["购买指南"] });
    await page("product", { url: "https://catalog.example/products/cup" });
    const other = await db.contentPillar.create({ data: { siteId, title: "Existing coverage", keyword: "other" } });
    const linked = await cluster("linked", { pillarId: other.id, url: "https://catalog.example/blog/bravo" });
    const result = await getImportablePages(db, userId, siteId, { page: "2", pageSize: "2", articlesOnly: "true" });
    expect(result).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(result.rows.map((row) => row.id)).toEqual(["charlie", "help"]);
    const matched = await getImportablePages(db, userId, siteId, { query: "BRAVO", articlesOnly: "false" });
    expect(matched.rows).toHaveLength(1);
    expect(matched.rows[0]).toMatchObject({ id: "bravo", existingClusterId: linked.id, existingPillarTitle: "Existing coverage" });
    expect((await getImportablePages(db, userId, siteId, { query: "CHOOSE A CUP" })).rows.map((row) => row.id)).toEqual(["charlie"]);
    expect((await getImportablePages(db, userId, siteId, { page: 9 })).rows).toEqual([]);
  });

  it("keeps editorial indexes and query pagination in the inventory without labeling them article candidates", async () => {
    const indexes = ["/article", "/article?cat_id=1", "/article?category_id=1", "/article?page=2", "/blog/", "/zh/resources", "/zh/NEWS/", "/knowledge-base/category/slides"];
    for (const [index, path] of indexes.entries()) {
      await page(`index-${index}`, { url: `https://catalog.example${path}`, h1s: ["教程与指南"] });
    }
    await page("article-detail", { url: "https://catalog.example/article/choosing-a-cup", h1s: ["教程与指南"] });
    await page("heading-detail", { url: "https://catalog.example/knowledge-base/slides", h1s: ["幻灯片教程"] });
    const inventory = await getImportablePages(db, userId, siteId, { articlesOnly: false });
    expect(inventory.total).toBe(indexes.length + 2);
    const indexRows = inventory.rows.filter((row) => row.id.startsWith("index-"));
    expect(indexRows).toHaveLength(indexes.length);
    expect(indexRows.every((row) => row.articleCandidate === false)).toBe(true);
    const candidates = await getImportablePages(db, userId, siteId, { articlesOnly: true });
    expect(candidates.total).toBe(2);
    expect(candidates.rows.map((row) => row.id).sort()).toEqual(["article-detail", "heading-detail"]);
  });

  it("rejects invalid page bounds and boolean query values", async () => {
    for (const options of [{ page: 0 }, { page: "NaN" }, { pageSize: 51 }, { pageSize: 0 }, { articlesOnly: "yes" }]) {
      await expect(getImportablePages(db, userId, siteId, options)).rejects.toMatchObject({ name: "ZodError" });
    }
  });
});

describe("bulk page imports", () => {
  it("imports edited fields with the recorded URL, marks published manual content, and creates no brief or job", async () => {
    const evidence = await page("one");
    expect(await importPages([item("one")])).toMatchObject({ ok: true, imported: 1, skipped: 0, results: [{ pageId: "one", status: "imported" }] });
    expect(await db.contentCluster.findFirstOrThrow()).toMatchObject({ pillarId, siteId, title: "Edited one", keyword: "keyword one", funnel: "MOFU", url: evidence.url, source: "MANUAL", status: "PUBLISHED", brief: null });
    expect(await db.contentPlanJob.count()).toBe(0);
    await expect(runContentAction(db, userId, siteId, { action: "importPages", pillarId, items: [{ ...item("one"), url: "https://outside.example/injected" }] })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("skips duplicate selections, links in any same-site pillar, and normalized keyword conflicts", async () => {
    await page("linked"); await page("conflict"); await page("new");
    const other = await db.contentPillar.create({ data: { siteId, title: "Other", keyword: "other" } });
    const linked = await cluster("other keyword", { pillarId: other.id, url: "https://catalog.example/blog/linked" });
    const conflict = await cluster("cup guide");
    const result = await importPages([item("linked"), item("conflict", "  CUP   GUIDE  "), item("new"), item("new")]);
    expect(result).toMatchObject({ imported: 1, skipped: 3, results: [
      { pageId: "linked", status: "skipped", reason: "already_linked", clusterId: linked.id },
      { pageId: "conflict", status: "skipped", reason: "keyword_conflict", clusterId: conflict.id },
      { pageId: "new", status: "imported" },
      { pageId: "new", status: "skipped", reason: "duplicate_in_request" },
    ] });
    const beforeRepeat = await db.contentCluster.findMany({ orderBy: { id: "asc" } });
    expect(await importPages([item("new")])).toMatchObject({ imported: 0, skipped: 1, results: [{ reason: "already_linked" }] });
    expect(await db.contentCluster.findMany({ orderBy: { id: "asc" } })).toEqual(beforeRepeat);
  });

  it("serializes simultaneous requests so only one creates each linked page", async () => {
    await page("one"); await page("two");
    const results = await Promise.all([importPages([item("one"), item("two")]), importPages([item("one"), item("two")])]);
    expect(results.map((result) => "imported" in result ? result.imported : -1).sort()).toEqual([0, 2]);
    expect(await db.contentCluster.count()).toBe(2);
  });

  it("preserves query strings and trailing slashes as distinct page identities in imports and linked annotations", async () => {
    const evidence = [
      { id: "slash", url: "https://catalog.example/article/cup/?edition=a" },
      { id: "no-slash", url: "https://catalog.example/article/cup?edition=a" },
      { id: "edition", url: "https://catalog.example/article/cup?edition=b" },
    ];
    for (const row of evidence) await page(row.id, { url: row.url });
    expect(await importPages([item("slash")])).toMatchObject({ imported: 1, skipped: 0 });
    const inventory = await getImportablePages(db, userId, siteId, {});
    expect(inventory.rows.filter((row) => row.existingClusterId).map((row) => row.id)).toEqual(["slash"]);
    expect(await importPages([item("no-slash"), item("edition")])).toMatchObject({ imported: 2, skipped: 0 });
    const rows = await db.contentCluster.findMany({ select: { url: true } });
    expect(rows.map((row) => row.url).sort()).toEqual(evidence.map((row) => row.url).sort());
  });

  it("rejects missing, stale, foreign-crawl, and foreign-pillar selections before importing any row", async () => {
    await page("valid"); await page("stale", { crawlId: "older" }); await page("foreign", { crawlId: "foreign-crawl" });
    for (const badId of ["missing", "stale", "foreign"]) {
      await expect(importPages([item("valid"), item(badId)])).rejects.toMatchObject({ status: 404 });
      expect(await db.contentCluster.count()).toBe(0);
    }
    await expect(importPages([item("valid")], foreignPillarId)).rejects.toMatchObject({ status: 404 });
    await expect(runContentAction(db, "foreign-owner", siteId, { action: "importPages", pillarId, items: [item("valid")] })).rejects.toMatchObject({ status: 404 });
    expect(await db.contentCluster.count()).toBe(0);
  });

  it("rejects non-HTML, non-2xx, and foreign-origin rows atomically, even when their IDs are in the latest crawl", async () => {
    await page("valid"); await page("asset", { url: "https://catalog.example/guide.json" });
    await page("error", { statusCode: 404 }); await page("external", { url: "https://foreign.example/blog/one" });
    await page("blank", { title: null, wordCount: 0 });
    await page("relative", { url: "/blog/relative" });
    await page("script", { url: "javascript:alert(1)" });
    await page("credentials", { url: "https://user:password@catalog.example/blog/one" });
    for (const badId of ["asset", "error", "external", "blank", "relative", "script", "credentials"]) {
      await expect(importPages([item("valid"), item(badId)])).rejects.toMatchObject({ status: 400 });
      expect(await db.contentCluster.count()).toBe(0);
    }
  });

  it("requires a completed crawl and rejects empty or oversized batches", async () => {
    await db.crawl.deleteMany({ where: { siteId } });
    await expect(importPages([item("one")])).rejects.toMatchObject({ status: 409 });
    for (const items of [[], Array.from({ length: 51 }, (_, index) => item(`page-${index}`))]) {
      await expect(importPages(items)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(await db.contentCluster.count()).toBe(0);
  });
});

describe("bulk topic updates", () => {
  it("moves selected topics and edits only chosen fields, preserving their briefs, URLs and schedules", async () => {
    const target = await db.contentPillar.create({ data: { siteId, title: "Target", keyword: "target" } });
    const original = await cluster("one", { source: "AI", contentType: "Checklist", intent: "Compare options", url: "https://catalog.example/blog/one", scheduledFor: new Date("2026-11-15T10:00:00Z"), brief: examplePlan().topics[0].brief as Prisma.InputJsonValue });
    const second = await cluster("two"); const untouched = await cluster("untouched");
    expect(await update([original.id, second.id, original.id], { pillarId: target.id, funnel: "BOFU", status: "PUBLISHED" })).toEqual({ ok: true, updated: 2 });
    const changed = await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } });
    expect(changed).toEqual({ ...original, pillarId: target.id, funnel: "BOFU", status: "PUBLISHED", updatedAt: expect.any(Date) });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: untouched.id } })).toEqual(untouched);
  });

  it("changes status without moving topics across their existing pillars", async () => {
    const other = await db.contentPillar.create({ data: { siteId, title: "Other", keyword: "other" } });
    const one = await cluster("one"); const two = await cluster("two", { pillarId: other.id });
    await update([one.id, two.id], { status: "REVIEW" });
    for (const original of [one, two]) {
      expect(await db.contentCluster.findUniqueOrThrow({ where: { id: original.id } })).toEqual({ ...original, status: "REVIEW", updatedAt: expect.any(Date) });
    }
  });

  it("rolls back all selected fields when moving would collide with an existing target keyword", async () => {
    const target = await db.contentPillar.create({ data: { siteId, title: "Target", keyword: "target" } });
    const one = await cluster("one"); const two = await cluster("two"); await cluster("two", { pillarId: target.id });
    const before = await db.contentCluster.findMany({ orderBy: { id: "asc" } });
    await expect(update([one.id, two.id], { pillarId: target.id, status: "PUBLISHED", funnel: "BOFU" })).rejects.toMatchObject({ status: 409 });
    expect(await db.contentCluster.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("rejects selected duplicate keywords from different pillars when they would converge in one pillar", async () => {
    const other = await db.contentPillar.create({ data: { siteId, title: "Other", keyword: "other" } });
    const target = await db.contentPillar.create({ data: { siteId, title: "Target", keyword: "target" } });
    const one = await cluster("same"); const two = await cluster("same", { pillarId: other.id });
    await expect(update([one.id, two.id], { pillarId: target.id, status: "WRITING" })).rejects.toMatchObject({ status: 409 });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: one.id } })).toEqual(one);
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: two.id } })).toEqual(two);
  });

  it("rejects foreign or missing topics and foreign destinations without partial changes", async () => {
    const own = await cluster("own");
    const foreign = await cluster("foreign", { siteId: "foreign-site", pillarId: foreignPillarId });
    for (const id of [foreign.id, "missing"]) await expect(update([own.id, id], { status: "PUBLISHED" })).rejects.toMatchObject({ status: 404 });
    await expect(update([own.id], { pillarId: foreignPillarId })).rejects.toMatchObject({ status: 404 });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: own.id } })).toEqual(own);
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreign);
  });

  it("requires one to fifty topics and explicit allowed changes", async () => {
    const own = await cluster("own");
    for (const [ids, data] of [
      [[], { status: "REVIEW" }], [Array(51).fill(own.id), { status: "REVIEW" }],
      [[own.id], {}], [[own.id], { title: "Unexpected overwrite" }], [[own.id], { status: "INVALID" }],
    ] as [string[], Record<string, unknown>][]) await expect(update(ids, data)).rejects.toMatchObject({ name: "ZodError" });
    expect(await db.contentCluster.findUniqueOrThrow({ where: { id: own.id } })).toEqual(own);
  });
});
