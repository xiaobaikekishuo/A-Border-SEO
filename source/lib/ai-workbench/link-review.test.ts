import { describe, expect, it } from "vitest";
import { hostOf, normalizeSourceUrl, sourceKey } from "./source-url";
import { reviewLinks } from "./link-review";
import { validateWorkbenchResult } from "./worker";
import { pageTitle } from "./trusted-sources";

const base = { title: "草稿", summary: "供审阅", contentMarkdown: "正文", metaTitle: "", metaDescription: "", changeNotes: [], factChecks: ["审核后使用"], internalLinks: [] };
const options = { domain: "site.test", allowedInternalLinks: ["https://site.test/guide"], trustedSources: ["https://www.who.int/news/item/report/"], body: "", language: "zh-CN" };

describe("source URLs", () => {
  it("normalizes addresses and drops tracking parameters and fragments", () => {
    expect(normalizeSourceUrl(" https://WWW.Who.int:443/news/item/report?utm_source=x&id=7#part ")).toBe("https://www.who.int/news/item/report?id=7");
    expect(normalizeSourceUrl("https://example.org/a?utm_medium=email")).toBe("https://example.org/a");
    expect(normalizeSourceUrl("www.example.org/a")).toBe("https://www.example.org/a");
    for (const bad of ["javascript:alert(1)", "ftp://example.org/a", "https://user:pw@example.org/", "https://localhost/a", "not a url", ""]) expect(normalizeSourceUrl(bad)).toBeNull();
  });
  it("compares spellings of one page as equal", () => {
    const key = sourceKey(normalizeSourceUrl("https://www.who.int/news/item/report/")!);
    expect(sourceKey(normalizeSourceUrl("http://who.int/news/item/report")!)).toBe(key);
    expect(sourceKey(normalizeSourceUrl("https://who.int/news/item/other")!)).not.toBe(key);
    expect(hostOf("https://www.who.int/x")).toBe("who.int");
    expect(hostOf("nothing")).toBe("");
  });
  it("reads a page title", () => {
    expect(pageTitle("<html><head><title>\n  WHO &amp; health &#8211; report &#x4e2d;\n</title></head></html>")).toBe("WHO & health – report 中");
    expect(pageTitle("<p>no title</p>")).toBeNull();
  });
});

describe("links in a finished draft", () => {
  it("keeps verified pages, trusted sources and links of the supplied text", () => {
    const contentMarkdown = "见[指南](/guide)和[报告](http://who.int/news/item/report)，原文链接 https://old.example.org/a 保留，[本页](#faq)。";
    const { result, review } = reviewLinks({ ...base, contentMarkdown }, { ...options, body: "旧文引用 https://old.example.org/a 。" });
    expect(result.contentMarkdown).toBe(contentMarkdown);
    expect(review).toEqual([]);
  });
  it("replaces other links in publishable text with a marker and lists them", () => {
    const contentMarkdown = [
      "研究显示[效果很好](https://invented.example/study)。",
      "![图](https://cdn.example.net/x.png)",
      "[ref]: https://ref.example.com/a",
      '<a href="https://html.example.org/b">链接</a>',
      "<https://auto.example.org/c>",
      "裸链接 https://bare.example.org/d。",
      "[站内未知](/invented)",
      "[脚本](javascript:alert(1))",
    ].join("\n");
    const { result, review } = reviewLinks({ ...base, contentMarkdown, title: "标题 https://t.example.org" }, options);
    expect(result.contentMarkdown).toContain("效果很好〔待核实：invented.example〕");
    expect(result.contentMarkdown).toContain("图〔待核实：cdn.example.net〕");
    expect(result.contentMarkdown).toContain("[ref]: 〔待核实：ref.example.com〕");
    expect(result.contentMarkdown).toContain('href="#待核实"');
    expect(result.contentMarkdown).toContain("裸链接 〔待核实：bare.example.org〕。");
    expect(result.contentMarkdown).toContain("站内未知〔待核实：site.test〕");
    expect(result.contentMarkdown).toContain("脚本〔已移除不安全链接〕");
    expect(result.contentMarkdown).not.toMatch(/invented\.example\/study|javascript:|auto\.example\.org\/c|bare\.example\.org\/d/);
    expect(result.title).toBe("标题 〔待核实：t.example.org〕");
    // Markdown links first, then references, HTML attributes, autolinks and bare addresses.
    expect(review.map(entry => [entry.field, entry.status])).toEqual([
      ["title", "UNVERIFIED"],
      ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNSAFE"],
      ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNVERIFIED"], ["contentMarkdown", "UNVERIFIED"],
    ]);
    expect(review.every(entry => entry.action === "REPLACED")).toBe(true);
    expect(review.find(entry => entry.status === "UNSAFE")?.url).toBe("javascript:alert(1");
    expect(review.some(entry => entry.url === "https://site.test/invented")).toBe(true);
  });
  it("keeps links in notes as text, drops unknown internal links and uses English markers", () => {
    const { result, review } = reviewLinks({ ...base,
      contentMarkdown: "Study: https://invented.example/study.",
      factChecks: ["Check https://source.example.org/data before citing"],
      internalLinks: [{ target: "https://site.test/guide", anchor: "guide", reason: "related" }, { target: "https://elsewhere.example/x", anchor: "x", reason: "see https://elsewhere.example/x" }],
    }, { ...options, language: "en" });
    expect(result.contentMarkdown).toBe("Study: [verify source: invented.example].");
    expect(result.factChecks).toEqual(["Check https://source.example.org/data before citing"]);
    expect(result.internalLinks).toEqual([{ target: "https://site.test/guide", anchor: "guide", reason: "related" }]);
    expect(review).toEqual([
      { url: "https://elsewhere.example/x", field: "internalLinks", status: "UNVERIFIED", action: "DROPPED", context: "x" },
      { url: "https://invented.example/study", field: "contentMarkdown", status: "UNVERIFIED", action: "REPLACED", context: "https://invented.example/study." },
      { url: "https://source.example.org/data", field: "factChecks", status: "UNVERIFIED", action: "KEPT_IN_NOTES", context: "https://source.example.org/data" },
    ]);
  });
  it("accepts other spellings of verified pages and gives internal link suggestions the verified spelling", () => {
    const contentMarkdown = "见 https://www.site.test/guide 和[指南](http://site.test/guide/)，以及 www.site.test/guide?utm_source=x 。";
    const { result, review } = reviewLinks({ ...base, contentMarkdown, internalLinks: [
      { target: "https://www.site.test/guide/", anchor: "指南", reason: "相关" }, { target: "/guide#faq", anchor: "常见问题", reason: "相关" },
    ] }, options);
    expect(result.contentMarkdown).toBe(contentMarkdown);
    expect(result.internalLinks.map(link => link.target)).toEqual(["https://site.test/guide", "https://site.test/guide"]);
    expect(review).toEqual([]);
    // Another port is another server.
    expect(reviewLinks({ ...base, contentMarkdown: "https://site.test:8443/guide" }, options).review).toHaveLength(1);
    expect(sourceKey(normalizeSourceUrl("https://who.int:8443/a")!)).not.toBe(sourceKey(normalizeSourceUrl("https://who.int/a")!));
  });
  it("judges the picture and the page of a linked image apart", () => {
    const { result, review } = reviewLinks({ ...base, contentMarkdown: [
      "[![封面](https://img.example.net/a.png)](https://site.test/guide)",
      "[![WHO](https://www.who.int/news/item/report)](https://invented.example/x)",
    ].join("\n") }, options);
    expect(result.contentMarkdown).toBe([
      "[封面〔待核实：img.example.net〕](https://site.test/guide)",
      "![WHO](https://www.who.int/news/item/report)〔待核实：invented.example〕",
    ].join("\n"));
    expect(review.map(entry => entry.url)).toEqual(["https://img.example.net/a.png", "https://invented.example/x"]);
  });
  it("names the address of a mail or phone link", () => {
    const { result, review } = reviewLinks({ ...base, contentMarkdown: "[写信](mailto:sales@site.test?subject=hi) [致电](tel:+86-10-1234)" }, options);
    expect(result.contentMarkdown).toBe("写信〔待核实：sales@site.test〕 致电〔待核实：+86-10-1234〕");
    expect(review.map(entry => entry.url)).toEqual(["mailto:sales@site.test?subject=hi", "tel:+86-10-1234"]);
  });
  it("keeps addresses inside code and lists them", () => {
    const contentMarkdown = [
      "运行：",
      "```bash",
      "curl https://api.invented.example/v1",
      "```",
      "或者 `GET https://api.invented.example/v2`，详见[`npm` 文档](https://docs.invented.example/npm)。",
      "~~~",
      "未闭合的代码块 https://api.invented.example/v3",
    ].join("\n");
    const { result, review } = reviewLinks({ ...base, contentMarkdown }, options);
    expect(result.contentMarkdown).toBe(contentMarkdown.replace("[`npm` 文档](https://docs.invented.example/npm)", "`npm` 文档〔待核实：docs.invented.example〕"));
    expect(review.map(entry => [entry.url, entry.action])).toEqual([
      ["https://docs.invented.example/npm", "REPLACED"],
      ["https://api.invented.example/v1", "KEPT_IN_CODE"],
      ["https://api.invented.example/v2", "KEPT_IN_CODE"],
      ["https://api.invented.example/v3", "KEPT_IN_CODE"],
    ]);
    // Text that already holds the placeholder characters is scanned whole.
    expect(reviewLinks({ ...base, contentMarkdown: "\ue000 `https://api.invented.example/v4`" }, options).result.contentMarkdown).toBe("\ue000 `〔待核实：api.invented.example〕`");
  });
  it("lists a link once per field and at most 50 links", () => {
    const contentMarkdown = Array.from({ length: 80 }, (_, i) => `https://many.example.org/${i % 60} https://many.example.org/${i % 60}`).join("\n");
    const { review } = reviewLinks({ ...base, contentMarkdown }, options);
    expect(review).toHaveLength(50);
    expect(new Set(review.map(entry => entry.url)).size).toBe(50);
  });
  it("completes the task instead of failing it, and ignores a link review from the model", () => {
    const context = { allowedInternalLinks: ["https://site.test/guide"], trustedSources: [{ url: "https://www.who.int/news/item/report", title: "WHO", note: null }], body: "" };
    const output = validateWorkbenchResult({ ...base, contentMarkdown: "[WHO](https://who.int/news/item/report/) [x](https://invented.example/y)",
      linkReview: [{ url: "https://fake.example", field: "title", status: "UNVERIFIED", action: "REPLACED", context: "" }] }, "site.test", context, "en");
    expect(output.contentMarkdown).toBe("[WHO](https://who.int/news/item/report/) x[verify source: invented.example]");
    expect(output.linkReview).toEqual([{ url: "https://invented.example/y", field: "contentMarkdown", status: "UNVERIFIED", action: "REPLACED", context: "[x](https://invented.example/y)" }]);
    expect(validateWorkbenchResult(base, "site.test", context)).toEqual(base);
  });
});
