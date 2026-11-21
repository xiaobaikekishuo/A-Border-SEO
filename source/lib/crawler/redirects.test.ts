import { describe, expect, it } from "vitest";
import { effectiveRedirectHops, redirectIssues, type RedirectRecord } from "./redirects";

const seedUrl = "https://shop.example/";
const record = (url: string, hops: [string, number, string][], finalUrl = hops[hops.length - 1][2]): RedirectRecord =>
  ({ url, finalUrl, finalStatus: 200, hops: hops.map(([from, status, location]) => ({ url: from, status, location })) });

describe("redirect findings", () => {
  it("ignores hops that only add or drop the trailing slash the crawler removes", () => {
    const hops = record("https://shop.example/blog", [["https://shop.example/blog", 301, "https://shop.example/blog/"]], "https://shop.example/blog").hops;
    expect(effectiveRedirectHops(hops)).toEqual([]);
    expect(redirectIssues({ records: [record("https://shop.example/blog", [["https://shop.example/blog", 301, "https://shop.example/blog/"]], "https://shop.example/blog")], links: [{ sourceUrl: "https://shop.example/", targetUrl: "https://shop.example/blog", isInternal: true }], sitemapUrls: [], seedUrl })).toEqual([]);
  });

  it("reports chains, sitemap entries and internal links, most severe first", () => {
    const issues = redirectIssues({
      records: [
        record("http://shop.example/old", [["http://shop.example/old", 301, "https://shop.example/old"], ["https://shop.example/old", 302, "https://shop.example/new"]]),
        record("https://shop.example/a", [["https://shop.example/a", 301, "https://shop.example/b"]]),
        record("https://shop.example/c", [["https://shop.example/c", 308, "https://shop.example/d"]]),
        // Nothing links to it and the sitemap does not list it: not reported.
        record("https://shop.example/", [["https://shop.example/", 301, "https://www.shop.example/"]]),
      ],
      links: [
        { sourceUrl: "https://shop.example/x", targetUrl: "http://shop.example/old", isInternal: true },
        { sourceUrl: "https://shop.example/x", targetUrl: "https://shop.example/c", isInternal: true },
        { sourceUrl: "https://shop.example/y", targetUrl: "https://shop.example/c", isInternal: true },
      ],
      sitemapUrls: ["https://shop.example/a"],
      seedUrl,
      howToFix: "fix",
    });
    expect(issues.map(i => [i.url, i.severity, i.message])).toEqual([
      ["http://shop.example/old", "WARNING", "Redirect chain: 2 hops to https://shop.example/new"],
      ["https://shop.example/a", "WARNING", "Sitemap lists a redirecting URL (301) → https://shop.example/b"],
      ["https://shop.example/c", "INFO", "2 internal links point to a redirect (308) → https://shop.example/d"],
    ]);
    expect(issues[0].details).toMatchObject({ kind: "chain", problems: ["chain", "internal_links", "temporary"], inlinks: 1, temporary: true, howToFix: "fix" });
    expect(issues[2].details).toMatchObject({ kind: "internal_links", inlinkSamples: ["https://shop.example/x", "https://shop.example/y"] });
  });

  it("keeps a redirect to another site informational", () => {
    const [issue] = redirectIssues({
      records: [record("https://shop.example/go/partner", [["https://shop.example/go/partner", 302, "https://partner.example/"], ["https://partner.example/", 301, "https://www.partner.example/"]])],
      links: [], sitemapUrls: [], seedUrl,
    });
    expect(issue).toMatchObject({ severity: "INFO", details: { kind: "chain", offsite: true } });
  });

  it("reports a URL once even when requested twice", () => {
    const r = record("https://shop.example/a", [["https://shop.example/a", 301, "https://shop.example/b"]]);
    expect(redirectIssues({ records: [r, r], links: [], sitemapUrls: ["https://shop.example/a"], seedUrl })).toHaveLength(1);
  });

  it("words a single internal link in the singular", () => {
    const [issue] = redirectIssues({
      records: [record("https://shop.example/a", [["https://shop.example/a", 301, "https://shop.example/b"]])],
      links: [{ sourceUrl: "https://shop.example/x", targetUrl: "https://shop.example/a", isInternal: true }], sitemapUrls: [], seedUrl,
    });
    expect(issue.message).toBe("1 internal link points to a redirect (301) → https://shop.example/b");
  });
});
