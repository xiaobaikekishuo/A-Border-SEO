import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import type { fetchPublic } from "@/lib/crawler/engine";
import { addTrustedSources, checkTrustedSource, listTrustedSources, MAX_TRUSTED_SOURCES, removeTrustedSource, trustedSourcesFor } from "./trusted-sources";

let database: TestDb; let db: PrismaClient;
const siteId = "trusted-site"; const userId = "trusted-owner";
beforeAll(async () => {
  database = await createTestDb(); db = database.db;
  await db.user.createMany({ data: [{ id: userId, email: "trusted@example.test" }, { id: "stranger", email: "stranger@example.test" }] });
  await db.site.create({ data: { id: siteId, userId, domain: "trusted.example" } });
}, 120000);
afterAll(async () => { await database?.close(); });

const fetcher = (impl: () => Promise<unknown>) => impl as unknown as typeof fetchPublic;

describe("trusted sources", () => {
  it("adds exact pages once, rejects other addresses and belongs to the site owner", async () => {
    const added = await addTrustedSources(db, userId, siteId, { sources: [
      { url: "https://www.who.int/news/item/report?utm_source=x", title: "WHO report" },
      { url: "http://who.int/news/item/report/" },
      { url: "javascript:alert(1)" },
      { url: "www.stats.gov.cn/sj/2025", note: "国家统计局公报" },
    ] });
    expect(added).toMatchObject({ added: 2, existing: 1, invalid: ["javascript:alert(1)"], full: false });
    expect(added.sources.map(source => source.url).sort()).toEqual(["https://www.stats.gov.cn/sj/2025", "https://www.who.int/news/item/report"]);
    expect(await addTrustedSources(db, userId, siteId, { sources: [{ url: "https://WHO.int/news/item/report" }] })).toMatchObject({ added: 0, existing: 1 });
    await expect(listTrustedSources(db, "stranger", siteId)).rejects.toMatchObject({ status: 404 });
    await expect(addTrustedSources(db, "stranger", siteId, { sources: [{ url: "https://example.org/x" }] })).rejects.toMatchObject({ status: 404 });
  });

  it("records the status of a checked page and fills an empty title", async () => {
    const source = (await listTrustedSources(db, userId, siteId)).find(entry => entry.url.includes("stats.gov.cn"))!;
    const ok = fetcher(async () => ({ res: new Response("<html><title> 统计公报 </title></html>", { headers: { "content-type": "text/html; charset=utf-8" } }), finalUrl: source.url, done: () => {} }));
    const checked = await checkTrustedSource(db, userId, siteId, source.id, ok);
    expect(checked.check).toEqual({ status: 200, finalUrl: source.url, title: "统计公报" });
    expect(checked.sources.find(entry => entry.id === source.id)).toMatchObject({ title: "统计公报", lastStatus: 200 });
    const down = fetcher(async () => { throw new Error("unreachable"); });
    const failed = await checkTrustedSource(db, userId, siteId, source.id, down);
    expect(failed.check.status).toBeNull();
    // The title found before stays; only the status changes.
    expect(failed.sources.find(entry => entry.id === source.id)).toMatchObject({ title: "统计公报", lastStatus: null });
    await expect(checkTrustedSource(db, userId, siteId, "missing", ok)).rejects.toMatchObject({ status: 404 });
  });

  it("gives a task the sources that share its words first", async () => {
    const picked = await trustedSourcesFor(db, siteId, "2025 统计数据");
    expect(picked[0]).toMatchObject({ url: "https://www.stats.gov.cn/sj/2025", note: "国家统计局公报" });
    expect(picked).toHaveLength(2);
  });

  it("removes a source and stops at the limit", async () => {
    const before = await listTrustedSources(db, userId, siteId);
    expect(await removeTrustedSource(db, userId, siteId, before[0].id)).toHaveLength(before.length - 1);
    for (let round = 0; round < 3; round++) {
      await addTrustedSources(db, userId, siteId, { sources: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.org/page-${round}-${i}` })) });
    }
    const last = await addTrustedSources(db, userId, siteId, { sources: [{ url: "https://example.org/one-more" }] });
    expect(last).toMatchObject({ added: 0, full: true });
    expect(last.sources).toHaveLength(MAX_TRUSTED_SOURCES);
    expect((await trustedSourcesFor(db, siteId, "page")).length).toBeLessThanOrEqual(20);
  });
});
