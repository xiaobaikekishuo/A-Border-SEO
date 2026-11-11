import { describe, expect, it } from "vitest";
import { analyzeAnswer, countMentions, domainMatches, markdownLinks, normalizeCitations, normalizeDomain, summarizeVisibility, type AnswerRow, type TrackingBrands } from "./visibility-rules";

const brands: TrackingBrands = {
  own: { name: "Kammak", aliases: ["卡玛克"], domains: ["kammakhome.com"] },
  competitors: [{ name: "Acme", aliases: [], domains: ["acme.test"] }, { name: "Nova", aliases: ["Nova Home"], domains: [] }],
};

describe("brand mentions and citations", () => {
  it("normalizes domains and matches subdomains only", () => {
    expect(normalizeDomain("https://WWW.KammakHome.com/x")).toBe("kammakhome.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(domainMatches("shop.kammakhome.com", "kammakhome.com")).toBe(true);
    expect(domainMatches("notkammakhome.com", "kammakhome.com")).toBe(false);
  });

  it("cleans citation URLs, drops tracking parameters and duplicates, and ranks them", () => {
    const list = normalizeCitations([
      { url: "https://kammakhome.com/sofa?utm_source=chatgpt.com#top", title: " Sofa " },
      { url: "https://kammakhome.com/sofa" },
      { url: "javascript:alert(1)" },
      { url: null },
      { url: "https://www.acme.test/a?id=2" },
    ]);
    expect(list).toEqual([
      { url: "https://kammakhome.com/sofa", domain: "kammakhome.com", title: "Sofa", rank: 1 },
      { url: "https://www.acme.test/a?id=2", domain: "acme.test", title: null, rank: 2 },
    ]);
    expect(markdownLinks("See [Kammak](https://kammakhome.com/) and https://acme.test/").map(l => l.url)).toContain("https://kammakhome.com/");
  });

  it("counts Latin names on word boundaries and Chinese names anywhere", () => {
    expect(countMentions("Kammak, kammak and Kammakhome", ["Kammak"]).count).toBe(2);
    expect(countMentions("推荐卡玛克的沙发，卡玛克很好", ["卡玛克"]).count).toBe(2);
    expect(countMentions("nothing here", ["Kammak"])).toEqual({ count: 0, first: -1 });
  });

  it("reads one answer for the site and its competitors", () => {
    const citations = normalizeCitations([{ url: "https://acme.test/" }, { url: "https://kammakhome.com/guide" }]);
    const analysis = analyzeAnswer("Acme is popular. Kammak (卡玛克) is a good alternative; Nova Home too.", citations, brands);
    expect(analysis).toMatchObject({ ownMentioned: true, ownCited: true, ownRank: 2, mentionRank: 2, competitorsCited: ["Acme"] });
    // Listed in settings order; mentionRank follows the order in the text.
    expect(analysis.mentions.map(m => m.name)).toEqual(["Kammak", "Acme", "Nova"]);
  });
});

describe("visibility summary", () => {
  const row = (over: Partial<AnswerRow>): AnswerRow => ({ platform: "CHATGPT", status: "OK", ownMentioned: false, ownCited: false, ownRank: null, mentionRank: null, mentions: [], citations: [], ...over });

  it("computes rates over answers, share of voice over answers that name a brand", () => {
    const own = { name: "Kammak", own: true, count: 1, first: 0 };
    const acme = { name: "Acme", own: false, count: 1, first: 5 };
    const v = summarizeVisibility([
      row({ ownMentioned: true, ownCited: true, ownRank: 1, mentionRank: 1, mentions: [own, acme], citations: normalizeCitations([{ url: "https://kammakhome.com/a" }]) }),
      row({ mentions: [acme], citations: normalizeCitations([{ url: "https://acme.test/" }]) }),
      row({}),
      row({ status: "NO_ANSWER" }),
      row({ status: "FAILED" }),
    ], brands);
    expect(v).toMatchObject({ answers: 3, noAnswer: 1, failed: 1, avgCitationRank: 1 });
    expect(v.mentionRate).toBeCloseTo(0.3333, 3);
    expect(v.citationRate).toBeCloseTo(0.3333, 3);
    expect(v.shareOfVoice).toBeCloseTo(0.3333, 3);
    expect(v.competitors[0]).toEqual({ name: "Acme", mentioned: 2, cited: 1 });
    expect(v.topDomains.find(d => d.domain === "kammakhome.com")).toEqual({ domain: "kammakhome.com", count: 1, own: true });
    expect(v.ownPages).toEqual([{ url: "https://kammakhome.com/a", count: 1 }]);
  });

  it("leaves rates empty without answers", () => {
    expect(summarizeVisibility([row({ status: "FAILED" })], brands)).toMatchObject({ answers: 0, mentionRate: null, citationRate: null, shareOfVoice: null });
  });
});
