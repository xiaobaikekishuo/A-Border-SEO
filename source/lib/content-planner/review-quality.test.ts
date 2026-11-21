import { describe, expect, it } from "vitest";
import { adLawCandidates, checkedAdLaw, isChineseText, markdownHeadings, mergedQuality, qualityTasks, reviewSignals, type ReviewSignals } from "./review-quality";
import { articleReviewRequestSchema, articleReviewSchema, finalizeArticleReview, validateArticleReview, type ArticleReviewRequest } from "./article-review-schema";
import { fitReviewRequest, REVIEW_TOO_LARGE } from "./article-review";
import { unjudgedAdLaw } from "./ad-law-coverage";

const zhText = "我们最好的扫地机是国家级认证产品，销量全国第一。第一步先拆开包装，第一时间充电。这是我们的第一手测试：连续使用 30 天，电池衰减 4%。最高级的配置在这里。";
const signals = (overrides: Partial<ReviewSignals> = {}): ReviewSignals => ({
  author: true, published: "2026-03-01", modified: "2026-10-01", fresh: true, sourceLinks: 2, sourceHosts: ["example.org"],
  headings: { total: 4, questions: 1 }, adLaw: null, ...overrides,
});

describe("ad-law candidates", () => {
  it("tells Chinese from Japanese and English text", () => {
    expect(isChineseText(zhText)).toBe(true);
    expect(isChineseText("これは最高の掃除機です。毎日使っています。")).toBe(false);
    expect(isChineseText("The best robot vacuum we tested in 2026.")).toBe(false);
  });
  it("finds absolute terms with context and skips ordinals and idioms", () => {
    const found = adLawCandidates(zhText);
    expect(found.map(value => value.term)).toEqual(["最好", "国家级", "第一", "最高级"]);
    expect(found[2].context).toContain("销量全国第一");
    // 第一步, 第一时间 and 第一手 are ordinals or idioms, and 最高级 wins over 最高.
    expect(found.some(value => value.context.startsWith("第一步"))).toBe(false);
  });
  it("keeps at most 20 candidates", () => {
    expect(adLawCandidates("最好的产品，".repeat(40).split("，").map((part, i) => `${part}${i}`).join("，"))).toHaveLength(20);
  });
});

describe("review signals", () => {
  const schemaReport = { version: 2, findings: [], entities: [], signals: { author: true, published: "2025-01-02", modified: null } };
  const geoSignals = { version: 1, sourceLinks: 3, sourceHosts: ["who.int", "example.org"], jsShell: false, published: "2025-01-02", modified: "2026-09-30" };
  it("reads author, dates and source links of a crawled article", () => {
    const value = reviewSignals({ text: "How it works. ".repeat(20), headings: ["How does it clean?", "Battery"], source: "CRAWL", schemaReport, geoSignals, crawlAt: new Date("2026-11-01T00:00:00Z") });
    expect(value).toEqual({ author: true, published: "2025-01-02", modified: "2026-09-30", fresh: true, sourceLinks: 3, sourceHosts: ["who.int", "example.org"],
      headings: { total: 2, questions: 1 }, adLaw: null });
  });
  it("uses markdown headings of pasted text and does not borrow the crawl's links", () => {
    const value = reviewSignals({ text: `## 为什么会掉电？\n${zhText}\n## 参数`, headings: ["Old crawl heading"], source: "PASTED", schemaReport, geoSignals, crawlAt: null });
    expect(value.headings).toEqual({ total: 2, questions: 1 });
    expect(value.sourceLinks).toBeNull();
    expect(value.adLaw?.length).toBeGreaterThan(0);
  });
  it("knows nothing about author and dates from a crawl before that evidence", () => {
    const value = reviewSignals({ text: "Plain text. ".repeat(20), headings: [], source: "CRAWL", schemaReport: null, geoSignals: null, crawlAt: null });
    expect(value).toMatchObject({ author: null, published: null, modified: null, fresh: null, sourceLinks: null, headings: null });
  });
  it("finds markdown headings", () => {
    expect(markdownHeadings("# Title\ntext\n### How long does it last? ###\n####### not a heading")).toEqual(["Title", "How long does it last?"]);
  });
});

describe("merged quality", () => {
  const text = "Short answer: yes, it cleans pet hair. We ran it for 30 days in our office. According to the EPA, filters matter.";
  it("keeps model judgements only with a quote from the text", () => {
    const quality = mergedQuality([
      { key: "DIRECT_ANSWER", status: "PASS", evidence: "Short answer:   yes, it cleans pet hair.", fix: "" },
      { key: "FIRST_HAND", status: "PASS", evidence: "We tested it for a year.", fix: "Add test photos." },
      { key: "SOURCED", status: "PARTIAL", evidence: "", fix: "Name the study." },
    ], signals(), text, []);
    expect(quality.map(value => [value.key, value.status])).toEqual([
      ["DIRECT_ANSWER", "PASS"], ["FIRST_HAND", "UNKNOWN"], ["SOURCED", "UNKNOWN"],
      ["AUTHOR_DATE", "PASS"], ["QUESTION_HEADINGS", "PASS"], ["AD_LAW", "NOT_APPLICABLE"],
    ]);
    expect(quality[0].evidence).toBe("Short answer: yes, it cleans pet hair.");
    expect(quality[1]).toMatchObject({ evidence: "", fix: "Add test photos." });
  });
  it("judges author, dates, subheadings and ad-law terms from the signals", () => {
    const status = (value: Partial<ReviewSignals>, adLaw = [] as Parameters<typeof mergedQuality>[3]) =>
      Object.fromEntries(mergedQuality([], signals(value), zhText, adLaw).slice(3).map(entry => [entry.key, entry.status]));
    expect(status({ author: false, published: null, modified: null, fresh: false })).toMatchObject({ AUTHOR_DATE: "FAIL" });
    expect(status({ fresh: false })).toMatchObject({ AUTHOR_DATE: "PARTIAL" });
    expect(status({ author: null, published: null, modified: null, fresh: null })).toMatchObject({ AUTHOR_DATE: "UNKNOWN" });
    expect(status({ headings: { total: 3, questions: 0 } })).toMatchObject({ QUESTION_HEADINGS: "FAIL" });
    expect(status({ headings: null })).toMatchObject({ QUESTION_HEADINGS: "UNKNOWN" });
    const candidates = adLawCandidates(zhText);
    expect(status({ adLaw: [] })).toMatchObject({ AD_LAW: "PASS" });
    expect(status({ adLaw: candidates })).toMatchObject({ AD_LAW: "PARTIAL" });
    const risk = { term: "最好", quote: "我们最好的扫地机", verdict: "RISK" as const, rewrite: "我们的扫地机" };
    expect(status({ adLaw: candidates }, [risk])).toMatchObject({ AD_LAW: "FAIL" });
    const exempt = candidates.map(value => ({ term: value.term, quote: value.term === "第一" ? "销量全国第一" : value.term, verdict: "LIKELY_EXEMPT" as const, rewrite: "" }));
    expect(status({ adLaw: candidates }, exempt)).toMatchObject({ AD_LAW: "PASS" });
  });
  it("needs a judgement for each place a term appears", () => {
    const text = "这是第一种清洁方法，适合新手。我们的产品销量全国第一，深受欢迎。";
    const candidates = adLawCandidates(text);
    expect(candidates.map(value => value.term)).toEqual(["第一", "第一"]);
    const exempt = { term: "第一", quote: "这是第一种清洁方法", verdict: "LIKELY_EXEMPT" as const, rewrite: "" };
    const risk = { term: "第一", quote: "我们的产品销量全国第一", verdict: "RISK" as const, rewrite: "我们的产品很受欢迎" };
    expect(unjudgedAdLaw(candidates, [exempt])).toEqual([candidates[1]]);
    // A quote too short to place still covers one place of its term.
    expect(unjudgedAdLaw(candidates, [{ term: "第一", quote: " 第一 " }])).toEqual([candidates[1]]);
    expect(unjudgedAdLaw(candidates, [exempt, { term: "第一", quote: "第一" }])).toEqual([]);
    const status = (judged: Parameters<typeof checkedAdLaw>[0]) => {
      const adLaw = checkedAdLaw(judged, signals({ adLaw: candidates }), text);
      return mergedQuality([], signals({ adLaw: candidates }), text, adLaw).find(entry => entry.key === "AD_LAW")?.status;
    };
    expect(status([exempt])).toBe("PARTIAL");
    expect(status([exempt, risk])).toBe("FAIL");
    expect(status([exempt, { ...risk, verdict: "LIKELY_EXEMPT", rewrite: "" }])).toBe("PASS");
  });
  it("drops ad-law judgements of unknown terms or quotes that are not in the text", () => {
    const candidates = adLawCandidates(zhText);
    const checked = checkedAdLaw([
      { term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "我们的扫地机" },
      { term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "duplicate" },
      { term: "唯一", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "x" },
      { term: "国家级", quote: "国家级认证的别家产品", verdict: "RISK", rewrite: "x" },
      { term: "第一", quote: "销量全国第一", verdict: "LIKELY_EXEMPT", rewrite: "should be cleared" },
    ], signals({ adLaw: candidates }), zhText);
    expect(checked).toEqual([
      { term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "我们的扫地机" },
      { term: "第一", quote: "销量全国第一", verdict: "LIKELY_EXEMPT", rewrite: "" },
    ]);
  });
  it("turns failed checks into brief tasks in the article's language", () => {
    const quality = mergedQuality([{ key: "SOURCED", status: "FAIL", evidence: "", fix: "注明数据来源。" }], signals({ author: false, published: null, modified: null, fresh: false, headings: { total: 2, questions: 0 }, adLaw: adLawCandidates(zhText) }), zhText,
      [{ term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "我们的扫地机" }]);
    const tasks = qualityTasks(quality, signals({ adLaw: [] }), [{ term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "我们的扫地机" }]);
    expect(tasks).toEqual([
      "QUALITY: 注明数据来源。",
      "QUALITY: 补充可见的作者署名和发布或更新日期，并在 Article 标记中填写 author、datePublished、dateModified；内容过时的先更新。",
      "QUALITY: 把 1 到 3 个小标题改成读者会问的问题，并在标题下第一句直接回答。",
      "QUALITY: 改写有广告法风险的绝对化用语：最好。",
    ]);
    expect(qualityTasks(undefined, null, undefined)).toEqual([]);
  });
});

describe("finished article reviews", () => {
  const request = (pageSignals?: ReviewSignals): ArticleReviewRequest => articleReviewRequestSchema.parse({
    pages: [{ pageId: "p1", url: "https://site.test/blog/a", title: "A", text: zhText, headings: ["参数"], source: "CRAWL", existingClusterId: null, existingUpdatedAt: null, ...(pageSignals ? { signals: pageSignals } : {}) }],
    pillars: [{ id: "pillar", title: "Guides", keyword: "guides", description: "" }], allowedInternalLinks: ["https://site.test/blog/b"], crawlAt: null,
  });
  const article = { pageId: "p1", pillarId: "pillar", keyword: "扫地机", funnel: "MOFU", confidence: "HIGH", reason: "测评文章", keep: [], add: [], rewrite: [], internalLinks: [] };
  it("saves all six checks and a review that still validates", () => {
    const saved = finalizeArticleReview({ summary: "ok", articles: [{ ...article,
      quality: [{ key: "FIRST_HAND", status: "PASS", evidence: "连续使用 30 天，电池衰减 4%。", fix: "" }],
      adLaw: [{ term: "最好", quote: "我们最好的扫地机", verdict: "RISK", rewrite: "我们的扫地机" }] }] },
    request(signals({ adLaw: adLawCandidates(zhText), headings: { total: 1, questions: 0 } })));
    const checks = Object.fromEntries(saved.articles[0].quality!.map(value => [value.key, value.status]));
    expect(checks).toEqual({ DIRECT_ANSWER: "UNKNOWN", FIRST_HAND: "PASS", SOURCED: "UNKNOWN", AUTHOR_DATE: "PASS", QUESTION_HEADINGS: "FAIL", AD_LAW: "FAIL" });
    expect(articleReviewSchema.parse(saved)).toEqual(saved);
  });
  it("reads reviews and requests saved before the checklist", () => {
    const saved = finalizeArticleReview({ summary: "ok", articles: [article] }, request());
    expect(saved.articles[0].quality?.every(value => value.status === "UNKNOWN")).toBe(true);
  });
  it("drops suggested links outside the verified pages instead of failing the review", () => {
    const link = { sourceSection: "参数", anchor: "相关文章", reason: "补充对比" };
    const saved = finalizeArticleReview({ summary: "ok", articles: [{ ...article, internalLinks: [
      { ...link, target: "https://elsewhere.test/x" },
      { ...link, target: "http://www.site.test/blog/b/" },
      { ...link, target: "/blog/a" },
      { ...link, target: "https://site.test/blog/invented" },
    ] }] }, request());
    expect(saved.articles[0].internalLinks).toEqual([{ ...link, target: "https://site.test/blog/b" }]);
    // A saved review is still checked strictly when it is applied.
    expect(() => validateArticleReview({ summary: "ok", articles: [{ ...article, internalLinks: [{ ...link, target: "https://elsewhere.test/x" }] }] }, request())).toThrow("verified URL");
  });
  it("shortens long excerpts evenly until the claim fits the local worker", () => {
    const long = { ...request(signals({ adLaw: [] })).pages[0], text: `${"这是一段很长的中文正文，用来测试本机生成服务的容量。".repeat(460)}最好`.slice(0, 12000) };
    const big = { ...request(), pages: [1, 2, 3, 4, 5].map(n => ({ ...long, pageId: `p${n}`, url: `https://site.test/blog/${n}` })) };
    const fitted = fitReviewRequest(big);
    expect(fitted.pages.every(page => page.excerptShortened && page.text.length < 12000 && page.text.length >= 1500)).toBe(true);
    expect(fitted.pages[0].signals?.adLaw).toEqual([]);
    const small = request();
    expect(fitReviewRequest(small)).toBe(small);
    const crowded = { ...big, pillars: Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: "x".repeat(250), keyword: "y".repeat(250), description: "z".repeat(1000) })) };
    expect(() => fitReviewRequest(crowded)).toThrow(REVIEW_TOO_LARGE);
  });
});
