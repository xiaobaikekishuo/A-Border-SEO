import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { COMPARISON_PAGE_LIMIT, compareSavedPages, getCrawlComparison, summarizeSchema } from "./crawl-comparison";

const url = "https://compare.example/article";
type Page = Parameters<typeof compareSavedPages>[0][number];
const page = (changes: Partial<Page> = {}): Page => ({ url, title: "Original", description: "Description", canonical: url, statusCode: 200, indexable: true, robotsMeta: null, xRobotsTag: null, noindexSource: null, schemaReport: null, ...changes });
const schema = { version: 1, coverage: "COMPLETE", truncated: false, jsonLdBlocks: 1, parsedBlocks: 1, entities: [{ types: ["Article"] }], findings: [{ code: "FIELD_RECOMMENDED", severity: "INFO", path: "$.author" }] };

describe("saved-page technical comparison", () => {
  it("reports directional field differences without treating noindex as Google index status", () => {
    const result = compareSavedPages([page()], [page({ title: "Updated", statusCode: 404, indexable: false, xRobotsTag: "noindex", noindexSource: "x-robots-tag" })]);
    expect(result[0].status).toBe("CHANGED");
    expect(result[0].changes).toContainEqual({ field: "title", before: "Original", after: "Updated", previewTruncated: false });
    expect(result[0].changes.find(change => change.field === "indexable")).toMatchObject({ before: true, after: false });
    expect(result[0].schema.comparison).toBe("UNKNOWN");
  });
  it("pairs only exact URLs, preserving protocol, www, query order, slash, encoding and fragments", () => {
    const variants = ["http://compare.example/article", "https://www.compare.example/article", `${url}/`, `${url}?a=1&b=2`, `${url}?b=2&a=1`, `${url}%2F`, `${url}#section`];
    const rows = compareSavedPages([page()], variants.map(url => page({ url })));
    expect(rows.filter(row => row.status === "ONLY_BEFORE")).toHaveLength(1);
    expect(rows.filter(row => row.status === "ONLY_AFTER")).toHaveLength(variants.length);
    expect(rows.every(row => !row.changes.length)).toBe(true);
  });
  it("marks duplicate records ambiguous instead of choosing an arbitrary before version", () => {
    expect(compareSavedPages([page(), page({ title: "Conflicting" })], [page()])[0]).toMatchObject({ status: "AMBIGUOUS", changes: [], schema: { comparison: "UNKNOWN" } });
  });
  it("keeps missing and partial Schema observations unknown, not fixed", () => {
    expect(compareSavedPages([page()], [page({ schemaReport: schema })])[0].schema.comparison).toBe("UNKNOWN");
    expect(compareSavedPages([page({ schemaReport: schema })], [page({ schemaReport: { ...schema, findings: [], coverage: "PARTIAL" } })])[0].schema.comparison).toBe("UNKNOWN");
    expect(summarizeSchema(null).state).toBe("UNKNOWN");
    expect(summarizeSchema({ version: 3, findings: [], entities: [] }).state).toBe("UNKNOWN");
    expect(summarizeSchema({ ...schema, version: 2 }).state).toBe("CHECKED");
  });
  it("compares checked type and finding summaries and ignores harmless array ordering", () => {
    const before = { ...schema, entities: [{ types: ["Organization", "Article"] }] };
    const after = { ...schema, entities: [{ types: ["Article", "Organization"] }] };
    expect(compareSavedPages([page({ schemaReport: before })], [page({ schemaReport: after })])[0].schema.comparison).toBe("SAME");
    expect(compareSavedPages([page({ schemaReport: schema })], [page({ schemaReport: { ...schema, findings: [] } })])[0]).toMatchObject({ status: "CHANGED", schema: { comparison: "CHANGED" } });
  });
  it("detects long-value changes before applying bounded display previews", () => {
    const prefix = "a".repeat(1000);
    const changes = compareSavedPages([page({ title: `${prefix}old` })], [page({ title: `${prefix}new` })])[0].changes;
    expect(changes).toEqual([{ field: "title", before: prefix, after: prefix, previewTruncated: true }]);
  });
});

let database: TestDb; let db: PrismaClient;
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: "compare-owner", email: "owner@compare.example" }, { id: "compare-other", email: "other@compare.example" }] });
  await db.site.createMany({ data: [{ id: "compare-site", domain: "compare.example", userId: "compare-owner" }, { id: "compare-foreign", domain: "foreign.example", userId: "compare-other" }] });
}, 120000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await db.crawl.deleteMany();
  await db.crawl.createMany({ data: [
    { id: "compare-before", siteId: "compare-site", status: "COMPLETED", finishedAt: new Date("2026-10-01T00:00:00Z"), maxPages: 1, pagesFound: 1 },
    { id: "compare-after", siteId: "compare-site", status: "COMPLETED", finishedAt: new Date("2026-11-01T00:00:00Z") },
    { id: "compare-running", siteId: "compare-site", status: "RUNNING", finishedAt: null },
    { id: "compare-foreign-crawl", siteId: "compare-foreign", status: "COMPLETED", finishedAt: new Date("2026-11-02T00:00:00Z") },
  ] });
  await db.auditPage.createMany({ data: [{ crawlId: "compare-before", url, statusCode: 200, title: "Before" }, { crawlId: "compare-after", url, statusCode: 200, title: "After" }, { crawlId: "compare-foreign-crawl", url: "https://foreign.example/private", statusCode: 200, title: "PRIVATE" }] });
});
const selection = { beforeId: "compare-before", afterId: "compare-after" };
const compare = (options: unknown = selection, owner: string | null = "compare-owner", site = "compare-site") => getCrawlComparison(db, owner, site, options);

describe("owner-gated crawl comparison", () => {
  it("lists only completed, timestamped crawls from the selected owned site", async () => {
    const result = await compare({});
    expect(result.crawls.map(crawl => crawl.id)).toEqual(["compare-after", "compare-before"]);
    expect(result.comparison).toBeNull();
    expect(result.crawls[1].sampleLimited).toBe(true);
    expect(result.crawls[1].storedPages).toBe(1);
  });
  it("rejects anonymous, foreign owner, cross-site IDs and incomplete crawls", async () => {
    await expect(compare(selection, null)).rejects.toMatchObject({ status: 401 });
    await expect(compare(selection, "compare-other")).rejects.toMatchObject({ status: 404 });
    await expect(compare({ ...selection, afterId: "compare-foreign-crawl" })).rejects.toMatchObject({ status: 404 });
    await expect(compare({ ...selection, afterId: "compare-running" })).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(await compare())).not.toContain("PRIVATE");
  });
  it("rejects reversed, duplicate, incomplete and forged requests", async () => {
    await expect(compare({ beforeId: selection.afterId, afterId: selection.beforeId })).rejects.toMatchObject({ status: 400 });
    await expect(compare({ beforeId: selection.beforeId, afterId: selection.beforeId })).rejects.toMatchObject({ status: 400 });
    await expect(compare({ beforeId: selection.beforeId })).rejects.toThrow();
    await expect(compare({ ...selection, score: 100 })).rejects.toThrow();
  });
  it("uses reviewed visible issue counts, retaining explicit unverified and excluded counts", async () => {
    await db.crawlIssue.createMany({ data: [
      { crawlId: "compare-before", url, type: "MISSING_TITLE", severity: "WARNING", message: "Visible" },
      { crawlId: "compare-before", url, type: "MISSING_DESCRIPTION", severity: "WARNING", message: "Unverified", details: { auditPolicy: { disposition: "unverified" } } },
      { crawlId: "compare-before", url, type: "MISSING_TITLE", severity: "INFO", message: "Summary", details: { kind: "crawl_summary" } },
      { crawlId: "compare-before", url, type: "DUPLICATE_TITLE", severity: "WARNING", message: "Excluded", details: { kind: "audit_excluded" } },
    ] });
    const result = (await compare()).comparison!;
    expect(result.before.issues).toEqual({ visible: 2, unverified: 1, excluded: 1 });
    expect(result.after.issues).toEqual({ visible: 0, unverified: 0, excluded: 0 });
    expect(result.rows[0].changes).toContainEqual({ field: "title", before: "Before", after: "After", previewTruncated: false });
  });
  it("reports bounded coverage and treats a missing sample counterpart as unknown", async () => {
    await db.auditPage.createMany({ data: Array.from({ length: COMPARISON_PAGE_LIMIT + 1 }, (_, i) => ({ crawlId: "compare-before", url: `https://compare.example/a${String(i).padStart(4, "0")}`, statusCode: 200 })) });
    const result = (await compare()).comparison!;
    expect(result.before.loadedPages).toBe(COMPARISON_PAGE_LIMIT);
    expect(result.before.storedPages).toBe(COMPARISON_PAGE_LIMIT + 2);
    expect(result.before.truncated).toBe(true);
    expect(result.rows.find(row => row.url === url)?.status).toBe("ONLY_AFTER");
    expect(result.totals.ONLY_AFTER).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/resolved|deleted|removed/i);
  });
});
