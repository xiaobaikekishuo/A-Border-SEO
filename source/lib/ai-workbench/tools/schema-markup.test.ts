import { describe, expect, it } from "vitest";
import type { WorkbenchResult } from "../schema";
import { reviewSchemaBlock, reviewSchemaResult, suggestSchemaTypes, type SchemaContext } from "./schema-markup";

const context: SchemaContext = {
  domain: "shop.test", types: ["Product", "BreadcrumbList"], suggested: ["Product", "BreadcrumbList"],
  page: { url: "https://shop.test/products/case", canonical: null, title: "Leather Phone Case | Shop", description: "A hand-stitched leather phone case.",
    h1s: ["Leather Phone Case"], headings: ["Materials", "Sizes"], published: null, modified: "2026-11-02", siteName: "Shop",
    homepage: "https://shop.test/", breadcrumb: [{ name: "Shop", url: "https://shop.test/" }, { name: "Products", url: "https://shop.test/products" }, { name: "Leather Phone Case", url: "https://shop.test/products/case" }],
    existingTypes: [] },
  body: "Hand-stitched from full-grain leather. Price: $39.99. SKU LC-200. Ships in 2 days.",
  allowedUrls: ["https://shop.test/products/case", "https://shop.test/", "https://shop.test/products"],
  allowedInternalLinks: ["https://shop.test/products/case", "https://shop.test/", "https://shop.test/products"],
  trustedSources: [{ url: "https://schema.org/" }],
};
const block = (type: "Product" | "BreadcrumbList" | "Article", value: unknown) => ({ type, code: typeof value === "string" ? value : JSON.stringify(value), missing: [] });
const base: WorkbenchResult = { title: "t", summary: "Blocks for this page.", contentMarkdown: "Explanation.", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["Test with the Rich Results Test"], internalLinks: [], paragraphEdits: [] };

describe("suggested types", () => {
  it("reads the page kind from its URL, dates and text", () => {
    const page = { body: "", published: null, wordCount: 100, headings: 0 };
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/" })).toEqual(["Organization", "WebSite"]);
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/products/case" })).toEqual(["Product", "BreadcrumbList"]);
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/blog/how-to" })).toEqual(["BlogPosting", "BreadcrumbList"]);
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/about", published: "2026-01-01" })).toEqual(["Article", "BreadcrumbList"]);
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/case", body: "Now only $19.99" })).toEqual(["Product", "BreadcrumbList"]);
    expect(suggestSchemaTypes({ ...page, url: "https://shop.test/contact" })).toEqual(["WebPage", "BreadcrumbList"]);
  });
});

describe("checking JSON-LD", () => {
  it("keeps facts on the page and removes invented ones", () => {
    const review = reviewSchemaBlock(block("Product", {
      "@context": "http://schema.org", "@type": "Product", "@id": "https://shop.test/products/case#product", name: "Leather Phone Case",
      description: "A hand-stitched leather phone case.", sku: "LC-200", gtin13: "4006381333931", image: "https://cdn.test/case.jpg",
      brand: { "@type": "Brand", name: "Shop" },
      offers: { "@type": "Offer", price: "39.99", priceCurrency: "USD", availability: "https://schema.org/InStock", url: "https://shop.test/products/case" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.8, reviewCount: 120 },
      sameAs: ["https://facebook.com/shop"],
    }), context);
    const node = JSON.parse(review.code);
    expect(review.status).toBe("READY");
    expect(node["@context"]).toBe("https://schema.org");
    expect(node["@id"]).toBe("https://shop.test/products/case#product");
    expect(node.sku).toBe("LC-200");
    expect(node.offers).toEqual({ "@type": "Offer", price: "39.99", url: "https://shop.test/products/case" });
    for (const key of ["gtin13", "image", "aggregateRating", "sameAs"]) expect(Object.keys(node)).not.toContain(key);
    expect(review.removed).toEqual(expect.arrayContaining([
      { path: "$.gtin13", reason: "NOT_ON_PAGE" }, { path: "$.image", reason: "IMAGE_UNKNOWN" },
      { path: "$.offers.priceCurrency", reason: "NOT_ON_PAGE" }, { path: "$.offers.availability", reason: "NOT_ON_PAGE" },
      { path: "$.aggregateRating.ratingValue", reason: "NOT_ON_PAGE" }, { path: "$.aggregateRating", reason: "INCOMPLETE" },
      { path: "$.sameAs[0]", reason: "URL_NOT_ALLOWED" },
    ]));
    expect(review.needs.map(n => n.property)).toEqual(expect.arrayContaining(["gtin13", "image", "priceCurrency", "availability", "ratingValue"]));
    expect(review.html.startsWith('<script type="application/ld+json">')).toBe(true);
  });
  it("needs an offer, review or rating for a product result, and corrects an unsupported headline", () => {
    const product = reviewSchemaBlock(block("Product", { "@context": "https://schema.org", "@type": "Product", name: "Best Case Ever 2027" }), context);
    expect(product.status).toBe("READY");
    expect(JSON.parse(product.code).name).toBe("Leather Phone Case");
    expect(product.removed).toContainEqual({ path: "$.name", reason: "TEXT_CORRECTED" });
    expect(product.needs.map(n => n.property)).toContain("offers");
    const article = reviewSchemaBlock(block("Article", { "@context": "https://schema.org", "@type": "Article", headline: "Totally new headline", dateModified: "2026-11-02", datePublished: "2020-01-01", author: { "@type": "Person", name: "Jane Doe" } }), context);
    const node = JSON.parse(article.code);
    expect(node.headline).toBe("Leather Phone Case");
    expect(node.dateModified).toBe("2026-11-02");
    expect(Object.keys(node)).not.toContain("datePublished");
    expect(Object.keys(node)).not.toContain("author");
    expect(article.needs.map(n => n.property)).toEqual(expect.arrayContaining(["datePublished", "author"]));
  });
  it("accepts a breadcrumb of the site's pages and asks for one with too few items", () => {
    const items = context.page.breadcrumb.map((crumb, i) => ({ "@type": "ListItem", position: i + 1, name: crumb.name, item: crumb.url }));
    const ok = reviewSchemaBlock(block("BreadcrumbList", { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items }), context);
    expect(ok.status).toBe("READY");
    expect(JSON.parse(ok.code).itemListElement).toHaveLength(3);
    const short = reviewSchemaBlock(block("BreadcrumbList", { "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1, name: "Elsewhere", item: "https://other.test/" }] }), context);
    expect(short.status).toBe("NEEDS_INPUT");
  });
  it("rejects what is not one JSON-LD entity of the declared type", () => {
    expect(reviewSchemaBlock(block("Product", "{ not json"), context)).toMatchObject({ status: "REJECTED", error: "INVALID_JSON" });
    expect(reviewSchemaBlock(block("Product", { "@type": "Article", headline: "x" }), context)).toMatchObject({ status: "REJECTED", error: "TYPE_MISMATCH" });
    expect(reviewSchemaBlock(block("Product", { "@graph": [] , "@type": "Product" }), context)).toMatchObject({ status: "REJECTED", error: "GRAPH_NOT_SUPPORTED" });
    // A fenced code block is unwrapped first.
    expect(reviewSchemaBlock(block("Product", "```json\n{\"@type\":\"Product\",\"name\":\"Leather Phone Case\"}\n```"), context).status).toBe("READY");
  });
  it("never closes the script element early", () => {
    const review = reviewSchemaBlock(block("Product", { "@type": "Product", name: "Leather Phone Case", slogan: "Stitched</script><script>alert(1)" }), context);
    expect(review.html.match(/<\/script>/gi)).toHaveLength(1);
  });
  it("writes the checked code into the draft and fails when nothing passed", () => {
    const result = reviewSchemaResult({ ...base, schemaBlocks: [block("Product", { "@type": "Product", name: "Leather Phone Case" }), block("Product", { "@type": "Product", name: "Duplicate" })] }, context, "zh-CN");
    expect(result.schemaBlocks).toHaveLength(1);
    expect(result.schemaReview).toHaveLength(1);
    expect(result.contentMarkdown).toContain("```html");
    expect(result.contentMarkdown).toContain("Product · 可以使用");
    let message = "";
    try { reviewSchemaResult({ ...base, schemaBlocks: [block("Product", "nope")] }, context, "en"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Codex did not return usable structured data for this page");
  });
});
