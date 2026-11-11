import { describe, expect, it } from "vitest";
import { analyzeStructuredData, isStructuredDataReport, STRUCTURED_DATA_LIMITS as LIMITS } from "./structured-data";

const page = { url: "https://example.com/article", title: "中文文章标题 | Example" };
const script = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const article = { "@context": "https://schema.org", "@type": "Article", headline: "中文文章标题", author: { "@type": "Person", name: "编辑" }, image: "/image.jpg", datePublished: "2026-11-06" };
const analyze = (value: unknown) => analyzeStructuredData(script(value), page);
const codes = (value: unknown) => analyze(value).findings.map(f => f.code);

describe("captured JSON-LD checks", () => {
  it("handles Chinese articles without English word-count rules or required-property errors", () => {
    const result = analyze(article);
    expect(result.coverage).toBe("COMPLETE");
    expect(result.entities[0].name).toBe("中文文章标题");
    expect(result.findings).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/score|grade|rating likelihood/i);
  });
  it("distinguishes absence from syntax failure and other markup", () => {
    const absent = analyzeStructuredData("<h1>普通网页</h1>", page);
    expect(absent.jsonLdBlocks).toBe(0);
    expect(absent.findings).toMatchObject([{ code: "NO_JSON_LD", severity: "INFO" }]);
    const other = analyzeStructuredData('<div itemscope itemtype="https://schema.org/Article">正文</div>', page);
    expect(other.otherMarkup).toBe(true);
    expect(analyzeStructuredData('<div itemscope/>', page).otherMarkup).toBe(true);
    expect(other.coverage).toBe("PARTIAL");
    expect(other.truncated).toBe(false);
    expect(other.findings.every(f => f.severity === "INFO")).toBe(true);
    const broken = analyzeStructuredData('<script type="application/ld+json">{"@type":</script>', page);
    expect(broken.parsedBlocks).toBe(0);
    expect(broken.findings[0]).toMatchObject({ code: "JSON_INVALID", severity: "ERROR" });
  });
  it("never executes scripts, fixes JSON, or exposes source as a parse error", () => {
    const result = analyzeStructuredData('<script type="application/ld+json">throw new Error("private string")</script><script>alert(1)</script>', page);
    expect(result.jsonLdBlocks).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private string");
  });
  it("supports uppercase and unquoted MIME type and harmless parameters", () => {
    expect(analyzeStructuredData(`<SCRIPT data-note="a>b" TYPE=APPLICATION/LD+JSON>${JSON.stringify(article)}</SCRIPT>`, page).parsedBlocks).toBe(1);
    expect(analyzeStructuredData(`<script type='application/ld+json; charset=utf-8'>${JSON.stringify(article)}</script>`, page).parsedBlocks).toBe(1);
  });
  it("preserves comment-like text inside JSON strings", () => {
    const result = analyze({ ...article, headline: "<!--literal-->" });
    expect(result.entities[0].name).toBe("<!--literal-->");
    expect(result.findings.some(f => f.code === "JSON_INVALID")).toBe(false);
    expect(analyze({ ...article, headline: "<div itemscope>example</div>" }).otherMarkup).toBe(false);
    expect(analyzeStructuredData('<!--<div itemscope>--><textarea><span typeof="Article"></textarea><p data-example="itemscope">text</p>', page).otherMarkup).toBe(false);
  });
  it("ignores fake scripts in HTML comments and raw-text/inert elements", () => {
    const fake = script({ "@context": "https://schema.org", "@type": "Fake" });
    const html = `<!--${fake}--><textarea>${fake}</textarea><title>${fake}</title><style>${fake}</style><template><template>${fake}</template>${fake}</template>${script(article)}`;
    const result = analyzeStructuredData(html, page);
    expect(result.jsonLdBlocks).toBe(1);
    expect(result.entities.some(e => e.types.includes("Fake"))).toBe(false);
  });
  it("treats the contents of a non-JSON script as raw text", () => {
    const result = analyzeStructuredData(`<script>"<script type='application/ld+json'>"</script>${script(article)}`, page);
    expect(result.jsonLdBlocks).toBe(1);
  });
  it("can inspect a raw-text script terminated by EOF", () => {
    const result = analyzeStructuredData(`<script type="application/ld+json">${JSON.stringify(article)}`, page);
    expect(result.parsedBlocks).toBe(1);
  });
  it("supports top-level arrays and graph context inheritance", () => {
    const result = analyze({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "Example" }, { ...article, "@context": undefined }] });
    expect(result.entities.map(e => e.types[0])).toEqual(["Organization", "Article", "Person"]);
    expect(result.findings).toEqual([]);
    expect(analyze([article, { "@context": "https://schema.org", "@type": "Organization", name: "Example" }]).entities).toHaveLength(3);
  });
  it("checks inherited @vocab but does not invent expansion for aliases or remote contexts", () => {
    expect(codes({ ...article, "@context": { "@vocab": "https://schema.org/" } })).toEqual([]);
    for (const context of [undefined, null, "https://example.com/context.json", { "@vocab": "https://schema.org", headline: "name" }]) {
      const result = analyze({ "@context": context, "@type": "Product" });
      expect(result.findings[0].code).toMatch(/^CONTEXT_/);
      expect(result.coverage).toBe("PARTIAL");
      expect(result.truncated).toBe(false);
      expect(result.findings.some(f => f.code === "PRODUCT_SNIPPET_ELIGIBILITY")).toBe(false);
    }
  });
  it("distinguishes invalid type and root shapes", () => {
    expect(codes({ "@context": "https://schema.org", "@type": 3 })).toContain("TYPE_INVALID");
    expect(codes({ "@context": "https://schema.org", "@type": [] })).toContain("TYPE_MISSING");
    for (const root of [null, "Article", 3, [null, "bad"]]) expect(codes(root)).toContain("JSON_ROOT_INVALID");
    expect(codes({ "@context": "https://schema.org", name: "Example" })).toContain("TYPE_MISSING");
  });
  it("does not classify Article or Organization recommendations as required", () => {
    for (const type of ["Article", "Organization"]) {
      const result = analyze({ "@context": "https://schema.org", "@type": type });
      expect(result.findings.every(f => f.code === "FIELD_RECOMMENDED" && f.severity === "INFO")).toBe(true);
    }
  });
  it("marks title and page URL differences as review observations, not errors", () => {
    const result = analyze({ ...article, headline: "另一篇文章", mainEntityOfPage: "https://example.com/canonical" });
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PAGE_TITLE_DIFFERENCE", severity: "INFO" }), expect.objectContaining({ code: "PAGE_URL_DIFFERENCE", severity: "INFO" })]));
    expect(result.findings.some(f => f.severity === "ERROR")).toBe(false);
    expect(codes({ ...article, mainEntityOfPage: { "@id": "/article#page" } })).not.toContain("PAGE_URL_DIFFERENCE");
  });
  it("checks invalid dates without accepting calendar overflow", () => {
    expect(codes({ ...article, datePublished: "2026-02-31" })).toContain("DATE_REVIEW");
    expect(codes({ ...article, datePublished: "2024-02-29T10:30:00+08:00" })).not.toContain("DATE_REVIEW");
  });
  it("reports product snippet prerequisites as feature-specific warnings", () => {
    const missing = analyze({ "@context": "https://schema.org", "@type": "Product" });
    expect(missing.findings.filter(f => f.code === "PRODUCT_SNIPPET_ELIGIBILITY")).toHaveLength(2);
    expect(missing.findings.every(f => f.severity === "WARNING")).toBe(true);
    expect(codes({ "@context": "https://schema.org", "@type": "Product", name: "Test", aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 } })).not.toContain("PRODUCT_SNIPPET_ELIGIBILITY");
  });
  it("checks direct offers while preserving unresolved graph references as unknown", () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Test" };
    expect(codes({ ...product, offers: { "@type": "Offer" } })).toContain("PRODUCT_SNIPPET_ELIGIBILITY");
    // A valid offer leaves only the merchant-listing note (image, brand, identifiers, availability, shipping, returns).
    expect(codes({ ...product, offers: { "@type": "Offer", price: 0, priceCurrency: "CNY" } })).toEqual(["MERCHANT_FIELDS_RECOMMENDED"]);
    expect(codes({ ...product, offers: { "@type": "AggregateOffer", lowPrice: "19.99", priceCurrency: "USD" } })).toEqual(["MERCHANT_FIELDS_RECOMMENDED"]);
    expect(analyze({ ...product, offers: { "@id": "#offer" } }).findings.find(f => f.code === "MERCHANT_FIELDS_RECOMMENDED")?.observed).toBe("image, brand, gtin / mpn / sku");
    expect(codes({ ...product, offers: { "@id": "#offer" } })).toContain("REFERENCE_NOT_RESOLVED");
    expect(codes({ ...product, offers: { "@id": "#offer" } })).not.toContain("PRODUCT_SNIPPET_ELIGIBILITY");
    expect(codes({ ...product, offers: { price: "$19", priceCurrency: "US" } })).toContain("FIELD_TYPE_INVALID");
    expect(analyze({ ...product, offers: { price: 19 } }).findings.find(f => f.path.endsWith("priceCurrency"))?.severity).toBe("INFO");
  });
  it("allows the final breadcrumb to omit its destination", () => {
    const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "首页", item: "/" }, { "@type": "ListItem", position: 2, name: "当前页" }] };
    expect(codes(breadcrumb)).toEqual([]);
    expect(codes({ ...breadcrumb, itemListElement: breadcrumb.itemListElement.slice(0, 1) })).toContain("BREADCRUMB_ELIGIBILITY");
    expect(codes({ ...breadcrumb, itemListElement: [{ position: 1, name: "A" }, { position: 1, name: "B" }] })).toContain("BREADCRUMB_ELIGIBILITY");
  });
  it("does not fetch URLs or accept executable URL schemes", () => {
    expect(codes({ "@context": "https://schema.org", "@type": "Organization", name: "Test", url: "javascript:alert(1)" })).toContain("URL_REVIEW");
  });
  it("caps oversized blocks and continues with later valid blocks", () => {
    const huge = script({ text: "中".repeat(LIMITS.blockBytes) });
    const result = analyzeStructuredData(huge + script(article), page);
    expect(result.coverage).toBe("PARTIAL");
    expect(result.parsedBlocks).toBe(1);
    expect(result.entities[0].name).toBe("中文文章标题");
  });
  it("caps document length and block count with explicit partial status", () => {
    const blocks = analyzeStructuredData(script(article).repeat(LIMITS.blocks + 2), page);
    expect(blocks.truncated).toBe(true);
    expect(blocks.findings.some(f => f.code === "LIMIT_REACHED")).toBe(true);
    const long = analyzeStructuredData(" ".repeat(LIMITS.htmlCharacters + 1), page);
    expect(long.coverage).toBe("PARTIAL");
  });
  it("bounds depth, findings and entity summaries", () => {
    let nested: unknown = article;
    for (let i = 0; i < LIMITS.depth + 2; i++) nested = { child: nested };
    const deep = analyze(nested);
    expect(deep.coverage).toBe("PARTIAL");
    const many = analyze({ "@context": "https://schema.org", "@graph": Array.from({ length: 100 }, (_, i) => ({ "@type": "Article", headline: `标题${i}` })) });
    expect(many.findings.length).toBeLessThanOrEqual(LIMITS.findings);
    expect(many.entities.length).toBeLessThanOrEqual(LIMITS.entities);
    expect(many.coverage).toBe("PARTIAL");
    expect(many.findings.some(f => f.code === "LIMIT_REACHED")).toBe(true);
    expect(JSON.stringify(many).length).toBeLessThan(100000);
  });
});

describe("version 2 checks: reviews, retired rich results and merchant fields", () => {
  const ctx = "https://schema.org";
  const shop = { url: "https://shop.example/products/mug", title: "Mug | Shop" };
  const run = (...values: unknown[]) => analyzeStructuredData(values.map(script).join(""), shop);
  const found = (...values: unknown[]) => run(...values).findings.map(f => f.code);
  const product = { "@context": ctx, "@type": "Product", name: "Mug", image: "/m.jpg", brand: { "@type": "Brand", name: "Kamma" }, sku: "M1",
    offers: { "@type": "Offer", price: "19.00", priceCurrency: "USD", availability: "https://schema.org/InStock", shippingDetails: { "@type": "OfferShippingDetails" }, hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy" } } };
  const organization = { "@context": ctx, "@type": "Organization", name: "Kamma Home", url: "https://shop.example/" };

  it("records entity signals for other checks and accepts older report versions", () => {
    expect(analyze(article)).toMatchObject({ version: 2, signals: { author: true, datePublished: true, dateModified: false, organization: false, product: false, reviews: false, faq: false } });
    expect(run(organization).signals?.organization).toBe(true);
    expect(isStructuredDataReport({ version: 1, findings: [], entities: [] })).toBe(true);
    expect(isStructuredDataReport({ version: 3, findings: [], entities: [] })).toBe(false);
  });
  it("notes retired FAQ and HowTo rich results without calling the markup an error", () => {
    expect(run({ "@context": ctx, "@type": "FAQPage", mainEntity: [] }).findings).toMatchObject([{ code: "FAQ_RICH_RESULT_RETIRED", severity: "INFO" }]);
    expect(found({ "@context": ctx, "@type": "HowTo", name: "Steps" })).toEqual(["HOWTO_RICH_RESULT_RETIRED"]);
  });
  it("lists missing merchant listing fields once per product, and nothing for a complete product", () => {
    expect(found(product)).toEqual([]);
    const minimal = run({ "@context": ctx, "@type": "Product", name: "Mug", offers: { "@type": "Offer", price: 19, priceCurrency: "USD" } });
    expect(minimal.findings).toMatchObject([{ code: "MERCHANT_FIELDS_RECOMMENDED", severity: "INFO", observed: "image, brand, gtin / mpn / sku, offers.availability, offers.shippingDetails, hasMerchantReturnPolicy" }]);
    expect(found({ ...product, offers: { ...product.offers, availability: "yes" } })).toContain("FIELD_TYPE_INVALID");
  });
  it("checks rating values and counts", () => {
    const rated = (aggregateRating: unknown) => found({ ...product, aggregateRating });
    expect(rated({ "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 32 })).toEqual(["REVIEW_GUIDELINES"]);
    expect(rated({ "@type": "AggregateRating", ratingValue: "96%", reviewCount: 32 })).toEqual(["RATING_REVIEW", "REVIEW_GUIDELINES"]);
    expect(rated({ "@type": "AggregateRating", ratingValue: 6, reviewCount: 3 })).toEqual(["RATING_REVIEW", "REVIEW_GUIDELINES"]);
    expect(rated({ "@type": "AggregateRating", ratingValue: 9, bestRating: 10, ratingCount: 3 })).toEqual(["REVIEW_GUIDELINES"]);
    expect(rated({ "@type": "AggregateRating", ratingValue: 4 })).toEqual(["RATING_REVIEW", "REVIEW_GUIDELINES"]);
    expect(rated({ "@type": "AggregateRating", ratingValue: 4, ratingCount: 0 })).toEqual(["RATING_REVIEW", "REVIEW_GUIDELINES"]);
  });
  it("flags reviews without a reviewer, placeholder reviewers and reviews written by the brand itself", () => {
    const rating = { "@type": "Rating", ratingValue: 5 };
    const reviewed = (review: unknown, ...more: unknown[]) => found({ ...product, review }, ...more);
    expect(reviewed({ "@type": "Review", reviewRating: rating })).toEqual(["REVIEW_AUTHOR_MISSING", "REVIEW_GUIDELINES"]);
    expect(reviewed({ "@type": "Review", author: { "@type": "Person", name: "Admin" }, reviewRating: rating })).toEqual(["REVIEW_AUTHOR_GENERIC", "REVIEW_GUIDELINES"]);
    expect(reviewed({ "@type": "Review", author: { "@type": "Person", name: "Lena W." }, reviewRating: rating })).toEqual(["REVIEW_GUIDELINES"]);
    expect(reviewed({ "@type": "Review", author: { "@type": "Organization", name: "kamma home" }, reviewRating: rating }, organization)).toEqual(["REVIEW_SELF_AUTHORED", "REVIEW_GUIDELINES"]);
    expect(reviewed({ "@type": "Review", author: "Kamma", reviewRating: rating })).toEqual(["REVIEW_SELF_AUTHORED", "REVIEW_GUIDELINES"]);
    expect(reviewed({ "@type": "Review", author: { "@type": "Person", name: "Lena" } })).toEqual(["RATING_REVIEW", "REVIEW_GUIDELINES"]);
  });
  it("warns about ratings an organization publishes about itself", () => {
    expect(found({ ...organization, aggregateRating: { "@type": "AggregateRating", ratingValue: 4.9, reviewCount: 120 } })).toEqual(["SELF_SERVING_REVIEW", "REVIEW_GUIDELINES"]);
  });
});
