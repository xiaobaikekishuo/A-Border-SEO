import { describe, expect, it } from "vitest";
import { citationGaps, sourceType, type GapAnswer } from "./citation-gap";

const brands = {
  own: { name: "Kammak", aliases: [], domains: ["kammak.example"] },
  competitors: [{ name: "Acme", aliases: [], domains: ["acme.example"] }, { name: "Zeta", aliases: [], domains: [] }],
};
const answer = (over: Partial<GapAnswer>): GapAnswer => ({
  promptId: "p1", platform: "CHATGPT", status: "OK", ownMentioned: false, ownCited: false,
  competitorsMentioned: [], competitorsCited: [], citations: [], ...over,
});
const cite = (url: string, rank = 1) => ({ url, domain: new URL(url).hostname.replace(/^www\./, ""), title: null, rank });

describe("citation gaps", () => {
  it("lists third-party sites cited where competitors appear and the brand does not", () => {
    const gaps = citationGaps([
      answer({ competitorsMentioned: ["Acme"], citations: [cite("https://www.g2.com/compare/a"), cite("https://acme.example/x"), cite("https://www.reddit.com/r/x")] }),
      answer({ promptId: "p2", platform: "PERPLEXITY", competitorsCited: ["Zeta"], citations: [cite("https://www.g2.com/b"), cite("https://www.g2.com/c")] }),
      // The brand is in this answer: g2 helps it here, which is not a gap.
      answer({ promptId: "p3", ownMentioned: true, competitorsMentioned: ["Acme"], citations: [cite("https://www.g2.com/d"), cite("https://kammak.example/")] }),
      // No competitor either: nothing to learn from this one.
      answer({ promptId: "p4", citations: [cite("https://en.wikipedia.org/wiki/Mug")] }),
      answer({ promptId: "p5", status: "FAILED", competitorsMentioned: ["Acme"], citations: [cite("https://www.youtube.com/watch?v=1")] }),
    ], brands);
    expect(gaps.map(g => [g.domain, g.type, g.gapAnswers, g.answers, g.withBrand])).toEqual([
      ["g2.com", "REVIEW", 2, 3, 1],
      ["reddit.com", "FORUM", 1, 1, 0],
    ]);
    expect(gaps[0]).toMatchObject({ competitors: ["Acme", "Zeta"], platforms: ["CHATGPT", "PERPLEXITY"], promptIds: ["p1", "p2"] });
    expect(gaps[0].urls).toHaveLength(3);
  });

  it("classifies sources by host and domain ending", () => {
    expect(sourceType("zhihu.com")).toBe("FORUM");
    expect(sourceType("baike.baidu.com")).toBe("ENCYCLOPEDIA");
    expect(sourceType("tieba.baidu.com")).toBe("FORUM");
    expect(sourceType("www.bilibili.com")).toBe("VIDEO");
    expect(sourceType("nih.gov")).toBe("GOV_EDU");
    expect(sourceType("www.tsinghua.edu.cn")).toBe("GOV_EDU");
    expect(sourceType("mp.weixin.qq.com")).toBe("BLOG");
    expect(sourceType("random-shop.example")).toBe("OTHER");
  });
});
