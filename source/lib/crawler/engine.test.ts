import { describe, it, expect } from "vitest";
import {
  matchManagedInfra,
  issuesFromPage,
  computeHealthScore,
  parseHtml,
  USER_AGENT,
  DEFAULT_USER_AGENT,
  crawlerUserAgent,
  type PageSnapshot,
  type IssueInput,
} from "./engine";

/* ------------------------------------------------------------------ */
/*  Helper: build a minimal valid PageSnapshot, overriding fields      */
/* ------------------------------------------------------------------ */

function makePage(overrides: Partial<PageSnapshot> & { url: string }): PageSnapshot {
  return {
    statusCode: 200,
    redirectUrl: null,
    title: "Test Page",
    description: "A description",
    h1s: ["Hello"],
    canonical: "https://example.com/",
    robotsMeta: null,
    wordCount: 500,
    contentScore: 80,
    internalOutlinks: [],
    externalOutlinks: [],
    links: [],
    hasSchema: true,
    hreflangTags: [],
    imageCount: 0,
    imagesMissingAlt: 0,
    bytes: 10_000,
    loadMs: 200,
    contentHash: "abc123",
    indexable: true,
    noindexSource: null,
    xRobotsTag: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  matchManagedInfra                                                  */
/* ------------------------------------------------------------------ */

describe("USER_AGENT", () => {
  it("names the bot with a stable product token", () => {
    expect(USER_AGENT).toBe(DEFAULT_USER_AGENT);
    expect(DEFAULT_USER_AGENT).toMatch(/^ABorderSEOBot\/1\.0 /);
  });

  it("accepts a well-formed CRAWLER_USER_AGENT and ignores anything else", () => {
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: "ABorderSEOBot/1.0 (+https://shop.example/bot)" })).toBe("ABorderSEOBot/1.0 (+https://shop.example/bot)");
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: "  " })).toBe(DEFAULT_USER_AGENT);
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: "no token here" })).toBe(DEFAULT_USER_AGENT);
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: "Bot/1.0\r\nX-Injected: 1" })).toBe(DEFAULT_USER_AGENT);
  });
});

describe("matchManagedInfra", () => {
  it("matches /cdn-cgi/l/email-protection as Cloudflare", () => {
    const result = matchManagedInfra("https://example.com/cdn-cgi/l/email-protection");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("Cloudflare");
  });

  it("matches bare /cdn-cgi/ path as Cloudflare", () => {
    const result = matchManagedInfra("https://example.com/cdn-cgi/");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("Cloudflare");
  });

  it("does NOT match /blog/cdn-cgi-explained (substring, not prefix)", () => {
    expect(matchManagedInfra("https://example.com/blog/cdn-cgi-explained")).toBeNull();
  });

  it("does NOT match site root /", () => {
    expect(matchManagedInfra("https://example.com/")).toBeNull();
  });

  it("returns null for malformed / relative URLs without throwing", () => {
    expect(() => matchManagedInfra("not-a-url")).not.toThrow();
    expect(matchManagedInfra("not-a-url")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  issuesFromPage — severity classification                           */
/* ------------------------------------------------------------------ */

describe("issuesFromPage", () => {
  const origin = "https://example.com";

  it("flags a normal 404 as CRITICAL BROKEN_LINK", () => {
    const page = makePage({ url: "https://example.com/missing", statusCode: 404 });
    const issues = issuesFromPage(page, origin);
    const broken = issues.find((i) => i.type === "BROKEN_LINK");
    expect(broken).toBeDefined();
    expect(broken!.severity).toBe("CRITICAL");
    expect(broken!.message).toContain("404");
  });

  it("flags a 500 on a normal URL as CRITICAL", () => {
    const page = makePage({ url: "https://example.com/error", statusCode: 500 });
    const issues = issuesFromPage(page, origin);
    const broken = issues.find((i) => i.type === "BROKEN_LINK");
    expect(broken).toBeDefined();
    expect(broken!.severity).toBe("CRITICAL");
  });

  it("downgrades /cdn-cgi/ 403 to INFO, not CRITICAL", () => {
    const page = makePage({
      url: "https://example.com/cdn-cgi/l/email-protection",
      statusCode: 403,
    });
    const issues = issuesFromPage(page, origin);
    const broken = issues.find((i) => i.type === "BROKEN_LINK");
    expect(broken).toBeDefined();
    expect(broken!.severity).toBe("INFO");
    expect(broken!.message).toContain("Cloudflare");
  });

  it("includes provider name in managed infra message", () => {
    const page = makePage({
      url: "https://example.com/cdn-cgi/trace",
      statusCode: 404,
    });
    const issues = issuesFromPage(page, origin);
    const broken = issues.find((i) => i.type === "BROKEN_LINK");
    expect(broken!.message).toContain("Cloudflare");
  });

  it("raises no BROKEN_LINK for 200 status", () => {
    const page = makePage({ url: "https://example.com/ok", statusCode: 200 });
    const issues = issuesFromPage(page, origin);
    expect(issues.find((i) => i.type === "BROKEN_LINK")).toBeUndefined();
  });

  it("returns early on error status — no further checks", () => {
    const page = makePage({
      url: "https://example.com/gone",
      statusCode: 410,
      title: null,
      description: null,
      h1s: [],
    });
    const issues = issuesFromPage(page, origin);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("BROKEN_LINK");
  });

  it("flags missing title as CRITICAL", () => {
    const page = makePage({ url: "https://example.com/no-title", title: null });
    const issues = issuesFromPage(page, origin);
    const missing = issues.find((i) => i.type === "MISSING_TITLE");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("CRITICAL");
  });

  it("flags missing meta description as WARNING", () => {
    const page = makePage({ url: "https://example.com/no-desc", description: null });
    const issues = issuesFromPage(page, origin);
    const missing = issues.find((i) => i.type === "MISSING_DESCRIPTION");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("WARNING");
  });

  it("flags slow page (>3s) as WARNING", () => {
    const page = makePage({ url: "https://example.com/slow", loadMs: 5000 });
    const issues = issuesFromPage(page, origin);
    const slow = issues.find((i) => i.type === "SLOW_PAGE");
    expect(slow).toBeDefined();
    expect(slow!.severity).toBe("WARNING");
  });
});

/* ------------------------------------------------------------------ */
/*  computeHealthScore                                                 */
/* ------------------------------------------------------------------ */

function issue(severity: "CRITICAL" | "WARNING" | "INFO"): IssueInput {
  return { url: "https://x.com", type: "BROKEN_LINK", severity, message: "test" };
}

describe("computeHealthScore (share of affected pages)", () => {
  const page = (n: number) => `https://x.com/p${n}`;
  const on = (type: IssueInput["type"], severity: IssueInput["severity"], urls: string[]): IssueInput[] =>
    urls.map((url) => ({ url, type, severity, message: "test" }));

  it("returns 100 for no issues", () => {
    expect(computeHealthScore([], 10)).toBe(100);
  });

  it("returns 0 for zero pages", () => {
    expect(computeHealthScore([], 0)).toBe(0);
  });

  it("weights one affected page by severity: 30, 12 or 3 times the square root of the share", () => {
    expect(computeHealthScore([issue("CRITICAL")], 10)).toBe(91); // 100 - 30 * sqrt(0.1)
    expect(computeHealthScore([issue("WARNING")], 10)).toBe(96); // 100 - 12 * sqrt(0.1)
    expect(computeHealthScore([issue("INFO")], 10)).toBe(99); // 100 - 3 * sqrt(0.1)
  });

  it("counts each page once per issue type, however many findings it has", () => {
    const many = Array.from({ length: 20 }, () => issue("CRITICAL"));
    expect(computeHealthScore(many, 10)).toBe(91);
  });

  it("does not drop a large site to zero for a minor issue on many pages", () => {
    const urls = Array.from({ length: 300 }, (_, i) => page(i));
    expect(computeHealthScore(on("MISSING_ALT", "INFO", urls), 1000)).toBe(98); // 100 - 3 * sqrt(0.3)
    expect(computeHealthScore(on("MISSING_DESCRIPTION", "WARNING", urls), 1000)).toBe(93); // 100 - 12 * sqrt(0.3)
  });

  it("adds issue types up and floors at 0", () => {
    const all = Array.from({ length: 10 }, (_, i) => page(i));
    const types: IssueInput["type"][] = ["BROKEN_LINK", "MISSING_TITLE", "MISSING_H1", "SLOW_PAGE"];
    const issues = types.flatMap((type) => on(type, "CRITICAL", all));
    expect(computeHealthScore(issues, 10)).toBe(0);
    // A critical type on half the pages plus a warning on all of them: 100 - 30 * sqrt(0.5) - 12.
    expect(computeHealthScore([...on("BROKEN_LINK", "CRITICAL", all.slice(0, 5)), ...on("MISSING_H1", "WARNING", all)], 10)).toBe(67);
  });

  it("takes the most severe finding of a type", () => {
    expect(computeHealthScore([issue("INFO"), issue("WARNING"), issue("CRITICAL")], 5)).toBe(87); // 100 - 30 * sqrt(0.2)
  });

  it("measures shares against the audited pages, so crawled noindex pages do not raise the score", () => {
    const one = [issue("WARNING")];
    expect(computeHealthScore(one, 2, 2)).toBe(92); // 100 - 12 * sqrt(1/2)
    // Two more pages crawled but not audited (noindex): the same score, not 100 - 12 * sqrt(1/4) = 94.
    expect(computeHealthScore(one, 2, 4)).toBe(92);
  });

  it("scores a crawl whose pages are all noindex on its site-wide findings, and an empty crawl 0", () => {
    const noRobots: IssueInput = { url: "https://x.com/", type: "MISSING_ROBOTS", severity: "WARNING", message: "test" };
    expect(computeHealthScore([], 0, 3)).toBe(100);
    expect(computeHealthScore([noRobots], 0, 3)).toBe(88);
    expect(computeHealthScore([noRobots], 0, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  parseHtml — unquoted attribute values (HTML5 / minified output)    */
/* ------------------------------------------------------------------ */

describe("parseHtml with unquoted attribute values", () => {
  // Shape produced by an HTML minifier: it drops the quotes on
  // values without spaces (`name=description`) and keeps them where the value
  // has spaces (`content="..."`), so both styles appear in the SAME tag.
  const minified = [
    "<html><head><title>Example Site</title>",
    '<meta content="A description with spaces in it." name=description>',
    "<link href=https://example.com/ rel=canonical>",
    "<meta content=index,follow name=robots>",
    "<link href=https://example.com/en/ hreflang=en rel=alternate>",
    "</head><body><h1>Example Site</h1>",
    "<a href=/contact/>Contact</a>",
    "<a href=/pricing/ rel=nofollow>Pricing</a>",
    "<a href=#top>Top</a>",
    "<img src=/logo.png alt=Logo>",
    "<img src=/decor.png>",
    "</body></html>",
  ].join("");

  const page = parseHtml(
    "https://example.com/",
    minified,
    200,
    120,
    minified.length,
    null,
    "https://example.com/"
  );

  it("reads a meta description written without quotes", () => {
    expect(page.description).toBe("A description with spaces in it.");
  });

  it("reads a canonical written without quotes", () => {
    expect(page.canonical).toBe("https://example.com/");
  });

  it("reads robots meta written without quotes", () => {
    expect(page.robotsMeta).toBe("index,follow");
    expect(page.indexable).toBe(true);
  });

  it("reads hreflang alternates written without quotes", () => {
    expect(page.hreflangTags).toEqual([
      { lang: "en", href: "https://example.com/en/" },
    ]);
  });

  it("follows links written without quotes", () => {
    expect(page.internalOutlinks).toEqual([
      "https://example.com/contact",
      "https://example.com/pricing",
    ]);
  });

  it("still skips in-page anchors", () => {
    expect(page.links.some((l) => l.targetUrl.includes("top"))).toBe(false);
  });

  it("detects rel=nofollow written without quotes", () => {
    const nofollow = page.links.find((l) => l.targetUrl.endsWith("/pricing"));
    expect(nofollow?.isNofollow).toBe(true);
  });

  it("counts only the image that really has no alt", () => {
    expect(page.imageCount).toBe(2);
    expect(page.imagesMissingAlt).toBe(1);
  });
});

describe("parseHtml with quoted attribute values", () => {
  const quoted = [
    "<html><head><title>Quoted</title>",
    '<meta name="description" content="Still works">',
    '<link rel="canonical" href="https://example.com/">',
    '</head><body><a href="/a" rel="nofollow noopener">A</a>',
    '<img src="/x.png" alt="">',
    "</body></html>",
  ].join("");

  const page = parseHtml(
    "https://example.com/",
    quoted,
    200,
    100,
    quoted.length,
    null,
    "https://example.com/"
  );

  it("did not regress the quoted form", () => {
    expect(page.description).toBe("Still works");
    expect(page.canonical).toBe("https://example.com/");
    expect(page.links[0]?.isNofollow).toBe(true);
  });

  it("does not treat an empty alt as missing", () => {
    // alt="" is how a decorative image is marked up; it is not a defect.
    expect(page.imageCount).toBe(1);
    expect(page.imagesMissingAlt).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  parseHtml — cases the quote-only patterns used to get right        */
/* ------------------------------------------------------------------ */

function parse(html: string) {
  return parseHtml(
    "https://example.com/",
    html,
    200,
    100,
    html.length,
    null,
    "https://example.com/"
  );
}

describe("parseHtml attribute lookup edge cases", () => {
  it("keeps scanning when the first matching tag lacks the wanted attribute", () => {
    const page = parse(
      '<meta name="robots"><meta name="robots" content="noindex">' +
        '<link rel="canonical"><link rel="canonical" href="https://example.com/real">'
    );
    expect(page.robotsMeta).toBe("noindex");
    expect(page.indexable).toBe(false);
    expect(page.canonical).toBe("https://example.com/real");
  });

  it("tolerates a > inside a quoted attribute value", () => {
    const page = parse('<meta name="description" content="Before > After">');
    expect(page.description).toBe("Before > After");
  });

  it("does not read href written inside another attribute's value", () => {
    const page = parse(`<a onclick="go('href=/tracker')" href="/real">x</a>`);
    expect(page.internalOutlinks).toEqual(["https://example.com/real"]);
  });

  it("keeps the full query string of an unquoted href", () => {
    const page = parse("<a href=/search?q=shoes&page=2>x</a>");
    expect(page.internalOutlinks).toEqual([
      "https://example.com/search?q=shoes&page=2",
    ]);
  });

  it("treats a whitespace-only alt as present, like the quoted patterns did", () => {
    const page = parse('<img src="/a.png" alt=" "><img src="/b.png">');
    expect(page.imagesMissingAlt).toBe(1);
  });

  it("separates a decorative image from one with no alt at all", () => {
    const page = parse(
      '<img src="/logo.png" alt=""><img src="/decor.png"><img src="/hero.png" alt="Hero">'
    );
    expect(page.imageCount).toBe(3);
    // Only /decor.png is a defect: alt="" marks /logo.png decorative on purpose.
    expect(page.imagesMissingAlt).toBe(1);
  });
});
