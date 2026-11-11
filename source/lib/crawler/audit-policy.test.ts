import { describe, expect, it } from "vitest";
import {
  classifyAuditIssues,
  computeAuditHealthScore,
  computePageShareHealthScore,
  type AuditPolicyIssue,
  type AuditPolicyPage,
} from "./audit-policy";

const ORIGIN = "https://catalog.example";
const PRODUCT = `${ORIGIN}/products/blue-cup`;
const ALIAS = `${ORIGIN}/collections/cups/products/blue-cup`;
const OTHER = `${ORIGIN}/products/red-cup`;
const HASH = "a1".repeat(32);
const OTHER_HASH = "b2".repeat(32);

function page(url: string, overrides: Partial<AuditPolicyPage> = {}): AuditPolicyPage {
  return {
    url,
    statusCode: 200,
    indexable: true,
    canonical: url,
    contentHash: HASH,
    title: "Ceramic cup",
    description: "A glazed ceramic cup for the kitchen.",
    ...overrides,
  };
}

function aliasPages(): AuditPolicyPage[] {
  return [page(PRODUCT), page(ALIAS, { canonical: PRODUCT })];
}

function duplicate(url: string, type = "DUPLICATE_TITLE"): AuditPolicyIssue {
  return {
    url,
    type,
    severity: type === "DUPLICATE_DESCRIPTION" ? "INFO" : "WARNING",
    message: "Metadata shared by multiple crawled pages",
    details: { howToFix: "Review the metadata.", urls: [PRODUCT, ALIAS] },
  };
}

function sitemap(url = ALIAS, details: AuditPolicyIssue["details"] = { kind: "not_in_sitemap" }): AuditPolicyIssue {
  return {
    url,
    type: "MISSING_SITEMAP",
    severity: "INFO",
    message: "Crawled page not listed in sitemap",
    details,
  };
}

function orphan(url = OTHER): AuditPolicyIssue {
  return {
    url,
    type: "MISSING_CANONICAL",
    severity: "WARNING",
    message: "Potential orphan page (no internal inlinks found)",
    details: { kind: "orphan", contentScore: 58, howToFix: "Add relevant internal links." },
  };
}

function inbound(overrides: Partial<{
  sourceUrl: string;
  targetUrl: string;
  verifiedAt: string;
  sourceStatus: number;
}> = {}) {
  return {
    sourceUrl: `${ORIGIN}/collections/cups?page=2`,
    targetUrl: OTHER,
    verifiedAt: "2026-11-04T08:00:00.000Z",
    sourceStatus: 200,
    ...overrides,
  };
}

function expectExcluded(actual: AuditPolicyIssue, original: AuditPolicyIssue) {
  expect(actual).toMatchObject({
    url: original.url,
    type: original.type,
    details: {
      kind: "audit_excluded",
      auditPolicy: {
        disposition: "excluded",
        original: {
          severity: original.severity,
          message: original.message,
          details: original.details ?? null,
        },
      },
    },
  });
}

describe("verified canonical aliases", () => {
  it.each(["DUPLICATE_TITLE", "DUPLICATE_DESCRIPTION"])(
    "excludes every %s row when the entire group represents one canonical page",
    (type) => {
      const issues = [duplicate(PRODUCT, type), duplicate(ALIAS, type)];
      const result = classifyAuditIssues(issues, aliasPages(), { incomplete: false });

      expect(result).toHaveLength(issues.length);
      result.forEach((issue, index) => expectExcluded(issue, issues[index]));
      expect(computeAuditHealthScore(result, 2)).toBe(100);
    },
  );

  it.each([null, PRODUCT])("accepts a target whose canonical is %j", (canonical) => {
    const issues = [sitemap()];
    const pages = [page(PRODUCT, { canonical }), page(ALIAS, { canonical: PRODUCT })];

    expectExcluded(classifyAuditIssues(issues, pages, { incomplete: false })[0], issues[0]);
  });

  it("collapses several verified aliases to one identity without removing stored rows", () => {
    const secondAlias = `${ORIGIN}/collections/gifts/products/blue-cup`;
    const pages = [...aliasPages(), page(secondAlias, { canonical: PRODUCT })];
    const issues = pages.map((p) => duplicate(p.url));
    const result = classifyAuditIssues(issues, pages, { incomplete: false });

    expect(result).toHaveLength(3);
    result.forEach((issue, index) => expectExcluded(issue, issues[index]));
  });

  it.each(["DUPLICATE_TITLE", "DUPLICATE_DESCRIPTION"])(
    "retains %s on different canonical pages while excluding their aliases",
    (type) => {
      const otherAlias = `${ORIGIN}/collections/gifts/products/red-cup`;
      const pages = [
        ...aliasPages(),
        page(OTHER, { contentHash: OTHER_HASH }),
        page(otherAlias, { canonical: OTHER, contentHash: OTHER_HASH }),
      ];
      const issues = pages.map((p) => duplicate(p.url, type));
      const result = classifyAuditIssues(issues, pages, { incomplete: false });

      expect(result[0]).toEqual(issues[0]);
      expectExcluded(result[1], issues[1]);
      expect(result[2]).toEqual(issues[2]);
      expectExcluded(result[3], issues[3]);
      expect(computeAuditHealthScore(result, 4)).toBe(type === "DUPLICATE_TITLE" ? 94 : 98);
    },
  );

  it("uses page metadata instead of stale issue URL lists to detect real duplicate titles", () => {
    const pages = [...aliasPages(), page(OTHER, { contentHash: OTHER_HASH })];
    const issues = pages.map((p) => duplicate(p.url));
    const result = classifyAuditIssues(issues, pages, { incomplete: false });

    expect(result[0]).toEqual(issues[0]);
    expectExcluded(result[1], issues[1]);
    expect(result[2]).toEqual(issues[2]);
  });

  it.each([
    ["DUPLICATE_TITLE", { title: "ceramic cup" }],
    ["DUPLICATE_TITLE", { title: "Ceramic cup " }],
    ["DUPLICATE_DESCRIPTION", { description: "A glazed ceramic cup for the kitchen. " }],
  ] satisfies Array<[string, Partial<AuditPolicyPage>]>)(
    "groups %s by exact metadata without folding case or whitespace",
    (type, overrides) => {
      const pages = [...aliasPages(), page(OTHER, overrides)];
      const issues = [duplicate(PRODUCT, type), duplicate(ALIAS, type)];
      const result = classifyAuditIssues(issues, pages, { incomplete: false });

      result.forEach((issue, index) => expectExcluded(issue, issues[index]));
    },
  );

  it.each([
    ["missing target", () => [page(ALIAS, { canonical: PRODUCT })]],
    ["broken target", () => [page(PRODUCT, { statusCode: 404 }), page(ALIAS, { canonical: PRODUCT })]],
    ["redirect target", () => [page(PRODUCT, { statusCode: 301 }), page(ALIAS, { canonical: PRODUCT })]],
    ["noindex target", () => [page(PRODUCT, { indexable: false }), page(ALIAS, { canonical: PRODUCT })]],
    ["canonical chain", () => [page(PRODUCT, { canonical: OTHER }), page(ALIAS, { canonical: PRODUCT }), page(OTHER)]],
    ["canonical cycle", () => [page(PRODUCT, { canonical: ALIAS }), page(ALIAS, { canonical: PRODUCT })]],
    ["different content", () => [page(PRODUCT), page(ALIAS, { canonical: PRODUCT, contentHash: OTHER_HASH })]],
    ["missing source hash", () => [page(PRODUCT), page(ALIAS, { canonical: PRODUCT, contentHash: null })]],
    ["missing target hash", () => [page(PRODUCT, { contentHash: null }), page(ALIAS, { canonical: PRODUCT })]],
    ["empty hashes", () => [page(PRODUCT, { contentHash: "" }), page(ALIAS, { canonical: PRODUCT, contentHash: "" })]],
    ["short hashes", () => [page(PRODUCT, { contentHash: "abcd" }), page(ALIAS, { canonical: PRODUCT, contentHash: "abcd" })]],
    ["nonhex hashes", () => [page(PRODUCT, { contentHash: "z".repeat(64) }), page(ALIAS, { canonical: PRODUCT, contentHash: "z".repeat(64) })]],
    ["cross-origin target", () => [page("https://other.example/product"), page(ALIAS, { canonical: "https://other.example/product" })]],
    ["different scheme", () => [page("http://catalog.example/product"), page(ALIAS, { canonical: "http://catalog.example/product" })]],
    ["different port", () => [page("https://catalog.example:8443/product"), page(ALIAS, { canonical: "https://catalog.example:8443/product" })]],
    ["only the slash-suffixed target was crawled", () => [page(`${PRODUCT}/`), page(ALIAS, { canonical: PRODUCT })]],
    ["self canonical", () => [page(PRODUCT), page(ALIAS)]],
    ["absent source canonical", () => [page(PRODUCT), page(ALIAS, { canonical: null })]],
  ] satisfies Array<[string, () => AuditPolicyPage[]]>)(
    "preserves duplicate and sitemap findings for an unverified alias: %s",
    (_label, makePages) => {
      const issues = [duplicate(ALIAS), duplicate(ALIAS, "DUPLICATE_DESCRIPTION"), sitemap()];

      expect(classifyAuditIssues(issues, makePages(), { incomplete: false })).toEqual(issues);
    },
  );
});

describe("sitemap coverage and real findings", () => {
  it.each([undefined, null, {}, { kind: "not_in_sitemap", howToFix: "Review coverage." }])(
    "recognizes legacy and tagged sitemap coverage findings with details %j",
    (details) => {
      const issue = { ...sitemap(), details };
      const result = classifyAuditIssues([issue], aliasPages(), { incomplete: false });

      expectExcluded(result[0], issue);
    },
  );

  it("recognizes the coverage kind without requiring the legacy message", () => {
    const issue = { ...sitemap(), message: "This URL was not found in the sitemap inventory" };

    expectExcluded(classifyAuditIssues([issue], aliasPages(), { incomplete: false })[0], issue);
  });

  it("keeps a missing sitemap file warning even on a verified alias", () => {
    const issue: AuditPolicyIssue = {
      ...sitemap(),
      severity: "WARNING",
      message: "No sitemap.xml found",
      details: { howToFix: "Publish a sitemap file." },
    };

    expect(classifyAuditIssues([issue], aliasPages(), { incomplete: false })).toEqual([issue]);
  });

  it("keeps sitemap coverage warnings on canonical pages", () => {
    const issue = sitemap(PRODUCT);

    expect(classifyAuditIssues([issue], aliasPages(), { incomplete: false })).toEqual([issue]);
  });

  it("does not hide real page findings merely because the page is an alias", () => {
    const issues: AuditPolicyIssue[] = [
      { url: ALIAS, type: "BROKEN_LINK", severity: "CRITICAL", message: "Link returns HTTP 404", details: { target: `${ORIGIN}/missing` } },
      { url: ALIAS, type: "MISSING_H1", severity: "WARNING", message: "Missing H1", details: null },
      { url: ALIAS, type: "MISSING_ALT", severity: "INFO", message: "Image lacks alt text" },
      { url: ALIAS, type: "MISSING_CANONICAL", severity: "WARNING", message: "Missing canonical tag", details: { howToFix: "Review canonical markup." } },
    ];

    expect(classifyAuditIssues(issues, aliasPages(), { incomplete: true })).toEqual(issues);
  });
});

describe("orphan evidence", () => {
  it("keeps limited-crawl orphan candidates visible without a health penalty", () => {
    const issue = orphan();
    const result = classifyAuditIssues([issue], [page(OTHER)], { incomplete: true });

    expect(result[0]).toMatchObject({
      url: OTHER,
      type: issue.type,
      severity: "INFO",
      details: {
        kind: "orphan",
        contentScore: 58,
        auditPolicy: {
          disposition: "unverified",
          original: { severity: "WARNING", message: issue.message, details: issue.details },
        },
      },
    });
    expect(result[0].message).toMatch(/limited crawl/i);
    expect(computeAuditHealthScore(result, 1)).toBe(100);
  });

  it("keeps the original orphan warning after a complete crawl", () => {
    const issue = orphan();
    const result = classifyAuditIssues([issue], [page(OTHER)], { incomplete: false });

    expect(result).toEqual([issue]);
    expect(computeAuditHealthScore(result, 1)).toBe(97);
  });

  it.each([true, false])("verified inbound anchors disprove an orphan even when incomplete=%s", (incomplete) => {
    const issue = orphan();
    const result = classifyAuditIssues([issue], [page(OTHER)], {
      incomplete,
      verifiedInboundLinks: [inbound()],
    });

    expectExcluded(result[0], issue);
    expect(result[0].details).toMatchObject({ auditPolicy: { reason: "verified_inbound_link" } });
    expect(computeAuditHealthScore(result, 1)).toBe(100);
  });

  it.each([
    ["404 source", { sourceStatus: 404 }],
    ["redirect source", { sourceStatus: 302 }],
    ["cross-origin source", { sourceUrl: "https://outside.example/category" }],
    ["self link", { sourceUrl: OTHER }],
    ["non-HTTP source", { sourceUrl: "file:///category.html" }],
    ["invalid source URL", { sourceUrl: "not a URL" }],
    ["different target", { targetUrl: PRODUCT }],
    ["cross-origin target", { targetUrl: "https://outside.example/products/red-cup" }],
    ["non-HTTP target", { targetUrl: "javascript:void(0)" }],
    ["missing verification time", { verifiedAt: "" }],
    ["invalid verification time", { verifiedAt: "not a date" }],
  ] satisfies Array<[string, Parameters<typeof inbound>[0]]>)(
    "leaves the limited-crawl candidate unverified with %s evidence",
    (_label, overrides) => {
      const result = classifyAuditIssues([orphan()], [page(OTHER)], {
        incomplete: true,
        verifiedInboundLinks: [inbound(overrides)],
      });

      expect(result[0]).toMatchObject({
        severity: "INFO",
        details: { kind: "orphan", auditPolicy: { disposition: "unverified" } },
      });
    },
  );

  it("does not let invalid inbound evidence suppress a complete-crawl orphan", () => {
    const issue = orphan();

    expect(classifyAuditIssues([issue], [page(OTHER)], {
      incomplete: false,
      verifiedInboundLinks: [inbound({ sourceStatus: 404 })],
    })).toEqual([issue]);
  });
});

describe("reprocessing and scoring", () => {
  it("is idempotent and leaves the caller's issues, pages, and evidence unchanged", () => {
    const issues = [duplicate(PRODUCT), duplicate(ALIAS), sitemap(), orphan(), orphan(PRODUCT)];
    const pages = [...aliasPages(), page(OTHER, { contentHash: OTHER_HASH, title: "Red cup" })];
    const options = { incomplete: true, verifiedInboundLinks: [inbound()] };
    const before = structuredClone({ issues, pages, options });

    const once = classifyAuditIssues(issues, pages, options);
    const twice = classifyAuditIssues(once, pages, options);

    expect(twice).toEqual(once);
    expect({ issues, pages, options }).toEqual(before);
    expect(once).toHaveLength(issues.length);
  });

  it("restores original warnings when the crawl is complete and inbound evidence is removed", () => {
    const issues = [orphan(OTHER), orphan(PRODUCT)];
    const pages = [page(OTHER), page(PRODUCT)];
    const classified = classifyAuditIssues(issues, pages, {
      incomplete: true,
      verifiedInboundLinks: [inbound()],
    });

    expect(classifyAuditIssues(classified, pages, { incomplete: false })).toEqual(issues);
  });

  it("restores excluded alias findings if later evidence no longer proves identical content", () => {
    const issues = [duplicate(PRODUCT), duplicate(ALIAS), sitemap()];
    const classified = classifyAuditIssues(issues, aliasPages(), { incomplete: false });
    const changedPages = [page(PRODUCT), page(ALIAS, { canonical: PRODUCT, contentHash: OTHER_HASH })];

    expect(classifyAuditIssues(classified, changedPages, { incomplete: false })).toEqual(issues);
  });

  it("preserves the legacy 8/3/1 severity deductions for real issues", () => {
    const issues: AuditPolicyIssue[] = [
      { url: PRODUCT, type: "BROKEN_LINK", severity: "CRITICAL", message: "Broken link" },
      { url: PRODUCT, type: "MISSING_H1", severity: "WARNING", message: "Missing H1" },
      { url: PRODUCT, type: "MISSING_ALT", severity: "INFO", message: "Missing alt text" },
    ];
    const additional = classifyAuditIssues([sitemap(), orphan()], aliasPages(), { incomplete: true });

    expect(computeAuditHealthScore(issues, 2)).toBe(88);
    expect(computeAuditHealthScore([...issues, ...additional], 2)).toBe(88);
  });

  it("returns zero for no pages, 100 for clean pages, and floors heavy penalties at zero", () => {
    expect(computeAuditHealthScore([], 0)).toBe(0);
    expect(computeAuditHealthScore([], 3)).toBe(100);
    expect(computeAuditHealthScore(Array.from({ length: 40 }, () => duplicate(PRODUCT)), 3)).toBe(0);
    expect(classifyAuditIssues([], [], { incomplete: true })).toEqual([]);
  });
});

describe("share-of-affected-pages health score", () => {
  it("ignores excluded, unverified and internal rows like the legacy score", () => {
    const pages = aliasPages();
    const reviewed = classifyAuditIssues([duplicate(PRODUCT), duplicate(ALIAS), sitemap(), orphan()], pages, { incomplete: true });
    const internal: AuditPolicyIssue = { url: PRODUCT, type: "MISSING_SCHEMA", severity: "INFO", message: "Crawl summary", details: { kind: "crawl_summary" } };
    // The alias duplicates and sitemap row are excluded and the orphan is unverified, so nothing is deducted.
    expect(computePageShareHealthScore([...reviewed, internal], 2)).toBe(100);
    // A real warning on one of two pages: 100 - 12 * sqrt(0.5).
    const real: AuditPolicyIssue = { url: OTHER, type: "MISSING_H1", severity: "WARNING", message: "Missing H1" };
    expect(computePageShareHealthScore([...reviewed, internal, real], 2)).toBe(92);
  });
  it("treats a missing robots.txt or sitemap as affecting the whole site", () => {
    const robots: AuditPolicyIssue = { url: `${ORIGIN}/robots.txt`, type: "MISSING_ROBOTS", severity: "WARNING", message: "robots.txt not found (404)" };
    const noSitemap: AuditPolicyIssue = { url: `${ORIGIN}/sitemap.xml`, type: "MISSING_SITEMAP", severity: "WARNING", message: "No sitemap.xml found" };
    expect(computePageShareHealthScore([robots], 500)).toBe(88);
    expect(computePageShareHealthScore([robots, noSitemap], 500)).toBe(76);
    // Pages missing from an existing sitemap are page-level findings: 2 of 100 pages barely move the score,
    // while a site-wide INFO finding would take 3 points.
    expect(computePageShareHealthScore([sitemap(PRODUCT), sitemap(ALIAS)], 100)).toBe(100);
    expect(computePageShareHealthScore([{ ...noSitemap, severity: "INFO" }], 100)).toBe(97);
  });
  it("keeps many findings of one type on one page from piling up", () => {
    expect(computePageShareHealthScore(Array.from({ length: 40 }, () => duplicate(PRODUCT)), 3)).toBe(93);
    expect(computeAuditHealthScore(Array.from({ length: 40 }, () => duplicate(PRODUCT)), 3)).toBe(0);
  });
});
