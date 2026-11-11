import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Exercise the crawl, persistence and visible-issue filter together. The
// Prisma client uses PGlite; every DNS lookup and HTTP request is stubbed.
const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));
const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});

import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { runSiteCrawl } from "./engine";
import { getVisibleIssues } from "./issue-filter";
import { AUDIT_EXCLUDED_KIND, AUDIT_POLICY_VERSION, originalAuditIssue } from "./audit-policy";

const ORIGIN = "https://quayline.app";
const PRODUCT = `${ORIGIN}/product`;
const VARIANT = `${PRODUCT}?sku_id=1`;
const SITE_ID = "canonical-site";
let t: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  t = await createTestDb();
  db = holder.db = t.db;
  await db.user.create({ data: { id: "canonical-user", email: "canonical-review@quayline.app" } });
  await db.site.create({
    data: { id: SITE_ID, userId: "canonical-user", domain: "quayline.app" },
  });
}, 120_000);

afterAll(async () => { await t?.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function html(canonical: string, title: string, description: string, body: string) {
  return new Response(
    `<html><head><title>${title}</title>` +
    `<meta name="description" content="${description}">` +
    `<link rel="canonical" href="${canonical}">` +
    '<script type="application/ld+json">{}</script>' +
    `</head><body>${body}</body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

/** All fixtures have three pages, a valid robots.txt and a valid sitemap. */
function stubSite(mode: "alias" | "distinct" | "orphan") {
  const productDescription = "A detailed product description shared only where this fixture intends duplication.";
  const productBody = '<h1>The product</h1><p>Product information.</p><a href="/">Home</a>';
  const sitemapUrls = mode === "alias" ? [`${ORIGIN}/`, PRODUCT] : [`${ORIGIN}/`, PRODUCT, VARIANT];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`, {
        status: 200, headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        sitemapUrls.map(value => `<url><loc>${value}</loc></url>`).join("") + "</urlset>",
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (url.pathname === "/") {
      return html(`${ORIGIN}/`, "Home of the test catalogue", "A unique description for the catalogue home page.",
        '<h1>Catalogue</h1><a href="/product">Product</a>' +
        (mode === "orphan" ? "" : '<a href="/product?sku_id=1">Variant</a>'));
    }
    if (url.pathname === "/product" && (!url.search || mode === "alias")) {
      // The canonical and alias return identical HTML, including the title,
      // description, extracted text and canonical pointing to PRODUCT.
      return html(PRODUCT, "A complete product title", productDescription, productBody);
    }
    if (url.pathname === "/product" && url.search === "?sku_id=1") {
      return html(VARIANT, "A distinct variant product title",
        mode === "distinct" ? productDescription : "A unique description for the sitemap-only variant.",
        '<h1>The separate variant</h1><p>Different information.</p><a href="/">Home</a>');
    }
    return new Response("not found", { status: 404 });
  }));
}

describe("canonical review during a crawl", () => {
  it("excludes verified alias findings from scores and visible issues while preserving their originals", async () => {
    stubSite("alias");
    const crawl = await runSiteCrawl(SITE_ID, "quayline.app", 50);
    expect(crawl.pagesFound).toBe(3);
    expect(crawl.issuesFound).toBe(0);
    expect(crawl.healthScore).toBe(100);

    const pages = await db.auditPage.findMany({
      where: { crawlId: crawl.crawlId, url: { in: [PRODUCT, VARIANT] } },
    });
    expect(pages).toHaveLength(2);
    expect(new Set(pages.map(page => page.contentHash)).size).toBe(1);
    for (const page of pages) {
      expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(page.canonical).toBe(PRODUCT);
      expect(page.statusCode).toBe(200);
      expect(page.indexable).toBe(true);
    }

    const visible = await getVisibleIssues(db, crawl.crawlId);
    expect(visible.total).toBe(0);
    expect(visible.issues).toEqual([]);
    expect(visible.bySeverity).toEqual({ CRITICAL: 0, WARNING: 0, INFO: 0 });
    expect(await db.crawl.findUnique({ where: { id: crawl.crawlId } })).toMatchObject({
      status: "COMPLETED", pagesFound: 3, issuesFound: 0, healthScore: 100,
    });

    const raw = await db.crawlIssue.findMany({ where: { crawlId: crawl.crawlId } });
    const excluded = raw.filter(row => object(row.details).kind === AUDIT_EXCLUDED_KIND);
    expect(excluded).toHaveLength(5);
    expect(excluded.filter(row => row.type === "DUPLICATE_TITLE")).toHaveLength(2);
    expect(excluded.filter(row => row.type === "DUPLICATE_DESCRIPTION")).toHaveLength(2);
    expect(excluded.filter(row => row.type === "MISSING_SITEMAP").map(row => row.url)).toEqual([VARIANT]);
    for (const row of excluded) {
      expect(object(object(row.details).auditPolicy)).toMatchObject({
        version: AUDIT_POLICY_VERSION, disposition: "excluded", canonical: PRODUCT,
      });
      const original = originalAuditIssue({ ...row, details: object(row.details) });
      expect(original.url).toBe(row.url);
      expect(original.type).toBe(row.type);
      expect(object(original.details).auditPolicy).toBeUndefined();
      if (row.type === "DUPLICATE_TITLE") {
        expect(original).toMatchObject({ severity: "WARNING", message: "Duplicate title shared by 2 pages" });
        expect(object(original.details).urls).toEqual(expect.arrayContaining([PRODUCT, VARIANT]));
      } else if (row.type === "DUPLICATE_DESCRIPTION") {
        expect(original).toMatchObject({ severity: "INFO", message: "Duplicate meta description on 2 pages" });
        expect(object(original.details).urls).toEqual(expect.arrayContaining([PRODUCT, VARIANT]));
      } else {
        expect(original).toMatchObject({ severity: "INFO", message: "Crawled page not listed in sitemap" });
        expect(object(original.details).kind).toBe("not_in_sitemap");
      }
    }
  });

  it("keeps duplicate descriptions on distinct self-canonical pages visible and scored", async () => {
    stubSite("distinct");
    const crawl = await runSiteCrawl(SITE_ID, "quayline.app", 50);
    expect(crawl.pagesFound).toBe(3);
    expect(crawl.issuesFound).toBe(2);
    expect(crawl.healthScore).toBe(98);
    const visible = await getVisibleIssues(db, crawl.crawlId);
    expect(visible.total).toBe(2);
    expect(visible.bySeverity).toEqual({ CRITICAL: 0, WARNING: 0, INFO: 2 });
    expect(visible.issues.map(row => row.url).sort()).toEqual([PRODUCT, VARIANT].sort());
    for (const row of visible.issues) {
      expect(row).toMatchObject({ type: "DUPLICATE_DESCRIPTION", severity: "INFO" });
      expect(object(row.details).auditPolicy).toBeUndefined();
    }
    const pages = await db.auditPage.findMany({
      where: { crawlId: crawl.crawlId, url: { in: [PRODUCT, VARIANT] } },
    });
    expect(new Set(pages.map(page => page.contentHash)).size).toBe(2);
    for (const page of pages) expect(page.canonical).toBe(page.url);
  });

  it("retains an orphan candidate but defers its health deduction when the crawl hits its cap", async () => {
    stubSite("orphan");
    const uncapped = await runSiteCrawl(SITE_ID, "quayline.app", 50);
    const capped = await runSiteCrawl(SITE_ID, "quayline.app", 3);
    expect(uncapped.pagesFound).toBe(3);
    expect(capped.pagesFound).toBe(3);
    expect(uncapped.issuesFound).toBe(1);
    expect(capped.issuesFound).toBe(1);
    expect(uncapped.healthScore).toBe(93); // one warning type on 1 of 3 pages: 100 - 12 * sqrt(1/3)
    expect(capped.healthScore).toBe(100);
    const before = await getVisibleIssues(db, uncapped.crawlId);
    const after = await getVisibleIssues(db, capped.crawlId);
    expect(before.issues).toHaveLength(1);
    expect(after.issues).toHaveLength(1);
    expect(before.issues[0]).toMatchObject({ url: VARIANT, severity: "WARNING" });
    expect(after.issues[0]).toMatchObject({ url: VARIANT, severity: "INFO" });
    expect(object(after.issues[0].details)).toMatchObject({
      kind: "orphan",
      auditPolicy: {
        version: AUDIT_POLICY_VERSION, disposition: "unverified", reason: "incomplete_link_graph",
        original: { severity: "WARNING", message: "Potential orphan page (no internal inlinks found)" },
      },
    });
    const summaries = await db.crawlIssue.findMany({
      where: { crawlId: { in: [uncapped.crawlId, capped.crawlId] }, message: "Crawl summary" },
    });
    const summaryFor = (id: string) => object(summaries.find(row => row.crawlId === id)?.details);
    expect(object(summaryFor(uncapped.crawlId).auditPolicy).incomplete).toBe(false);
    expect(object(summaryFor(capped.crawlId).auditPolicy).incomplete).toBe(true);
  });
});
