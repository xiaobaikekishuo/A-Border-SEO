import { describe, expect, it } from "vitest";
import { declaredDates, geoPageSignals, isoDay, jsShellOf, siteKey, sourceLinksOf } from "./geo-signals";

describe("cited sources", () => {
  it("counts main-content links to other sites, not navigation, sidebars, share buttons or the site itself", () => {
    const html = `<body><nav><a href="https://other.example/nav">Nav</a></nav>
      <article><p>See the <a href="https://www.who.int/report">WHO report</a> and <a href="https://www.who.int/report#table">its table</a>,
      the <a href="//standards.example.org/iso">standard</a>, our <a href="/guide">guide</a> and <a href="https://blog.shop.example/post">blog</a>.</p>
      <a href="https://twitter.com/intent/tweet?url=x">Share</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
      <aside><a href="https://ads.example/buy">Ad</a></aside></article>
      <footer><a href="https://other.example/footer">Footer</a></footer></body>`;
    expect(sourceLinksOf(html, "https://shop.example/blog/a")).toEqual({ count: 2, hosts: ["who.int", "standards.example.org"] });
  });

  it("treats subdomains and country second-level domains as one site", () => {
    expect(siteKey("www.shop.example.co.uk")).toBe("example.co.uk");
    expect(siteKey("blog.example.com")).toBe("example.com");
    expect(siteKey("example.com.cn")).toBe("example.com.cn");
  });
});

describe("app shells", () => {
  it("marks an empty mount element or a JavaScript notice with little served text", () => {
    expect(jsShellOf(`<body><div id="root"></div><script src="/app.js"></script></body>`, 3)).toBe("empty_mount");
    expect(jsShellOf(`<body><app-root></app-root></body>`, 3)).toBe("empty_mount");
    expect(jsShellOf(`<noscript>You need to enable JavaScript to run this app.</noscript><div id="app">Loading</div>`, 5)).toBe("noscript_notice");
    expect(jsShellOf(`<noscript>请启用 JavaScript 后访问本页</noscript>`, 10)).toBe("noscript_notice");
    expect(jsShellOf(`<body><script>render()</script></body>`, 2)).toBe("no_text");
  });

  it("does not mark server-rendered pages", () => {
    expect(jsShellOf(`<div id="__next"><main><h1>Mugs</h1><p>Text</p></main></div>`, 400)).toBeNull();
    // An empty mount next to plenty of served text is a widget, not a shell.
    expect(jsShellOf(`<div id="root"></div>`, 600)).toBeNull();
    expect(jsShellOf(`<div id="app-header"></div>`, 40)).toBeNull();
  });
});

describe("declared dates", () => {
  it("reads meta tags and time elements, newest first", () => {
    const html = `<head><meta property="article:published_time" content="2025-03-01T08:00:00+08:00">
      <meta property="article:modified_time" content="2026-02-10T10:00:00Z"><meta name="date" content="2024-01-01"></head>
      <body><article><time datetime="2025-03-01">March 1</time><time itemprop="dateModified" datetime="2026-05-02">May</time></article></body>`;
    expect(declaredDates(html)).toEqual({ published: "2025-03-01", modified: "2026-05-02" });
  });

  it("falls back to the first unlabelled time element for the publication date", () => {
    expect(declaredDates(`<main><time datetime="2026-01-15">Jan 15</time><time datetime="2026-02-01"></time></main>`)).toEqual({ published: "2026-01-15", modified: null });
  });

  it("accepts real dates only", () => {
    expect(isoDay("2026-02-30")).toBeNull();
    expect(isoDay("1980-01-01")).toBeNull();
    expect(isoDay("Tue, 03 Mar 2026 10:00:00 GMT")).toBe("2026-03-03");
    expect(isoDay("next week")).toBeNull();
  });

  it("combines meta, time and JSON-LD dates with the served text", () => {
    const signals = geoPageSignals(`<body><article><p>Text</p></article></body>`, "https://shop.example/blog/a", {
      textUnits: 300, schemaDates: { published: "2025-01-01", modified: "2026-04-01T09:00:00Z" },
    });
    expect(signals).toEqual({ version: 1, sourceLinks: 0, sourceHosts: [], jsShell: false, jsReason: null, textUnits: 300, published: "2025-01-01", modified: "2026-04-01" });
  });
});
