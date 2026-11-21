import { domainMatches, type Citation, type TrackingBrands } from "./visibility-rules";

/*
 * Citation gaps: the third-party sites AI answers cite when they name or cite
 * a competitor and leave the brand out. Those are the reviews, lists, forums,
 * encyclopedias and media the platforms trust for the topic; being covered
 * there is the usual way into such answers.
 *
 * Counted over the latest answers (lib/geo/tracking.ts), one per answer: a
 * site cited three times in one answer counts once. The site type comes from
 * a short list of well-known hosts and domain endings; everything else is
 * OTHER.
 */

export type SourceType = "REVIEW" | "FORUM" | "VIDEO" | "ENCYCLOPEDIA" | "NEWS" | "BLOG" | "SOCIAL" | "GOV_EDU" | "OTHER";

export type GapAnswer = {
  promptId: string;
  platform: string;
  status: "OK" | "NO_ANSWER" | "FAILED";
  ownMentioned: boolean;
  ownCited: boolean;
  /** Competitors the answer names. */
  competitorsMentioned: string[];
  /** Competitors with a cited page. */
  competitorsCited: string[];
  citations: readonly Citation[];
};

export type CitationGap = {
  domain: string;
  type: SourceType;
  /** Answers citing this site that name or cite a competitor and neither name nor cite the brand. */
  gapAnswers: number;
  /** Every latest answer citing this site. */
  answers: number;
  /** Of those, answers that name or cite the brand: the site does sometimes help it. */
  withBrand: number;
  competitors: string[];
  platforms: string[];
  promptIds: string[];
  /** Up to three cited pages of the site. */
  urls: string[];
};

const HOSTS: [SourceType, string[]][] = [
  ["REVIEW", ["g2.com", "capterra.com", "trustpilot.com", "getapp.com", "softwareadvice.com", "trustradius.com", "producthunt.com", "yelp.com",
    "tripadvisor.com", "consumerreports.org", "wirecutter.com", "rtings.com", "pcmag.com", "techradar.com", "tomsguide.com", "cnet.com",
    "dianping.com", "smzdm.com", "amazon.com", "amazon.co.uk", "amazon.de", "amazon.co.jp", "jd.com", "tmall.com", "taobao.com"]],
  ["FORUM", ["reddit.com", "quora.com", "stackoverflow.com", "stackexchange.com", "news.ycombinator.com", "zhihu.com", "tieba.baidu.com",
    "v2ex.com", "douban.com", "xiaohongshu.com", "ptt.cc", "dcard.tw"]],
  ["VIDEO", ["youtube.com", "youtu.be", "vimeo.com", "bilibili.com", "b23.tv", "douyin.com", "tiktok.com", "ixigua.com"]],
  ["ENCYCLOPEDIA", ["wikipedia.org", "wikimedia.org", "britannica.com", "wikihow.com", "baike.baidu.com", "baike.com", "investopedia.com"]],
  ["NEWS", ["nytimes.com", "wsj.com", "bbc.com", "bbc.co.uk", "reuters.com", "bloomberg.com", "theguardian.com", "forbes.com", "cnbc.com",
    "techcrunch.com", "theverge.com", "wired.com", "businessinsider.com", "36kr.com", "huxiu.com", "thepaper.cn", "sina.com.cn", "sohu.com",
    "163.com", "ifeng.com", "caixin.com", "people.com.cn", "xinhuanet.com"]],
  ["BLOG", ["medium.com", "substack.com", "wordpress.com", "blogspot.com", "dev.to", "hashnode.dev", "juejin.cn", "csdn.net", "jianshu.com",
    "cnblogs.com", "sspai.com", "mp.weixin.qq.com"]],
  ["SOCIAL", ["linkedin.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "threads.net", "pinterest.com", "weibo.com"]],
];

export function sourceType(domain: string): SourceType {
  const host = domain.toLowerCase().replace(/^www\./, "");
  for (const [type, hosts] of HOSTS) if (hosts.some(h => domainMatches(host, h))) return type;
  if (/\.(?:gov|edu|mil|int)$|\.(?:gov|edu|ac|mil)\.[a-z]{2}$/.test(host)) return "GOV_EDU";
  return "OTHER";
}

export function citationGaps(answers: readonly GapAnswer[], brands: TrackingBrands, limit = 50): CitationGap[] {
  const isBrandDomain = (domain: string) =>
    [brands.own, ...brands.competitors].some(entity => entity.domains.some(d => domainMatches(domain, d)));
  const byDomain = new Map<string, CitationGap & { promptSet: Set<string>; platformSet: Set<string>; competitorSet: Set<string> }>();
  for (const answer of answers) {
    if (answer.status !== "OK") continue;
    const brandPresent = answer.ownMentioned || answer.ownCited;
    const competitors = [...new Set([...answer.competitorsMentioned, ...answer.competitorsCited])];
    const gap = !brandPresent && competitors.length > 0;
    const seen = new Set<string>();
    for (const citation of answer.citations) {
      const domain = citation.domain;
      if (isBrandDomain(domain)) continue;
      let entry = byDomain.get(domain);
      if (!entry) {
        entry = {
          domain, type: sourceType(domain), gapAnswers: 0, answers: 0, withBrand: 0, competitors: [], platforms: [], promptIds: [], urls: [],
          promptSet: new Set(), platformSet: new Set(), competitorSet: new Set(),
        };
        byDomain.set(domain, entry);
      }
      if (entry.urls.length < 3 && !entry.urls.includes(citation.url)) entry.urls.push(citation.url);
      if (seen.has(domain)) continue;
      seen.add(domain);
      entry.answers++;
      if (brandPresent) entry.withBrand++;
      if (gap) {
        entry.gapAnswers++;
        entry.promptSet.add(answer.promptId);
        entry.platformSet.add(answer.platform);
        for (const name of competitors) entry.competitorSet.add(name);
      }
    }
  }
  return [...byDomain.values()]
    .filter(entry => entry.gapAnswers > 0)
    .sort((a, b) => b.gapAnswers - a.gapAnswers || b.answers - a.answers || a.domain.localeCompare(b.domain))
    .slice(0, limit)
    .map(({ promptSet, platformSet, competitorSet, ...entry }) => ({
      ...entry,
      competitors: [...competitorSet].sort(),
      platforms: [...platformSet].sort(),
      promptIds: [...promptSet].slice(0, 20),
    }));
}
