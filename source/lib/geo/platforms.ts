/*
 * The AI platforms the GEO view reports on, and how each one can be checked.
 * A platform is a surface where people get AI answers; each layer of the
 * platform view reads one kind of evidence:
 *
 *   access      robots.txt rules and a live request with each crawler's user agent
 *   eligibility page-level directives that platform documents (crawl data)
 *   index       the search index the platform draws on (Search Console, Bing)
 *   report      the platform owner's own report, imported as CSV
 *   answers     whether its answers mention or cite the site (prompt tracking)
 *   traffic     referred sessions (GA4) and crawler requests (access logs)
 *
 * Facts below follow each provider's documentation as read in November 2026.
 * A rule here says what a signal means for eligibility; it never claims that a
 * platform will show, cite or rank a page.
 */

export const GEO_PLATFORM_IDS = [
  "CHATGPT", "GOOGLE_AIO", "GOOGLE_AI_MODE", "GEMINI", "PERPLEXITY", "COPILOT", "CLAUDE", "GROK", "META_AI", "DEEPSEEK",
  // Assistants used in China, recorded by hand. Appended: stored answers keep their platform ids.
  "DOUBAO", "YUANBAO", "QWEN", "KIMI", "ERNIE",
] as const;
export type GeoPlatformId = (typeof GEO_PLATFORM_IDS)[number];

/** INDEX: builds the index answers draw on. USER: fetches a page a person asked about. TRAINING: model training only. */
export type CrawlerRole = "INDEX" | "USER" | "TRAINING";
export type PlatformCrawler = {
  /** robots.txt product token, as in lib/seo/ai-bots.ts. */
  token: string;
  role: CrawlerRole;
  /** User agent sent by the live access check. The product token is what CDN and WAF rules match on. */
  userAgent: string;
};

/** Which page-level directives decide whether a page can be used in answers. */
export type EligibilityRules = "GOOGLE" | "BING" | "GENERIC";
/** Prompt tracking source: a DataForSEO endpoint, or answers recorded by hand. */
export type AnswerSource =
  | { kind: "DATAFORSEO"; endpoint: "CHATGPT_SCRAPER" | "GEMINI_SCRAPER" | "GOOGLE_AI_OVERVIEW" | "GOOGLE_AI_MODE" | "PERPLEXITY_RESPONSES" | "CLAUDE_RESPONSES" }
  | { kind: "MANUAL" };

export type GeoPlatform = {
  id: GeoPlatformId;
  name: string;
  nameZh: string;
  vendor: string;
  crawlers: readonly PlatformCrawler[];
  /** robots.txt tokens without a crawler of their own that still gate this platform (Google-Extended for Gemini). */
  controlTokens: readonly string[];
  eligibility: EligibilityRules;
  /** The search index whose coverage this platform depends on, as far as the provider documents it. */
  index: "GOOGLE" | "BING" | null;
  /** Platform owner's report that can be imported. */
  report: "GSC_AI" | "BING_AI" | null;
  /** Names used for referral rows (lib/geo/import.ts) and crawler rows (provider · token). */
  referrers: readonly string[];
  answers: AnswerSource;
  note: { en: string; zh: string };
};

const UA_PREFIX = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ";
const ua = (product: string, suffix = "") => `${UA_PREFIX}${product})${suffix}`;
const CHROME = " Chrome/131.0.0.0 Safari/537.36";
/** The baseline request: an ordinary desktop browser. */
export const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GOOGLEBOT: PlatformCrawler = { token: "Googlebot", role: "INDEX", userAgent: ua("Googlebot/2.1", CHROME) };
const BINGBOT: PlatformCrawler = { token: "Bingbot", role: "INDEX", userAgent: ua("bingbot/2.0", CHROME) };

export const GEO_PLATFORMS: readonly GeoPlatform[] = [
  {
    id: "CHATGPT", name: "ChatGPT", nameZh: "ChatGPT", vendor: "OpenAI",
    crawlers: [
      { token: "OAI-SearchBot", role: "INDEX", userAgent: ua("OAI-SearchBot/1.3") },
      { token: "ChatGPT-User", role: "USER", userAgent: ua("ChatGPT-User/1.0") },
      { token: "GPTBot", role: "TRAINING", userAgent: ua("GPTBot/1.3") },
    ],
    controlTokens: [], eligibility: "GENERIC", index: "BING", report: null,
    referrers: ["ChatGPT"],
    answers: { kind: "DATAFORSEO", endpoint: "CHATGPT_SCRAPER" },
    note: {
      en: "ChatGPT search shows sites OAI-SearchBot may crawl; it also draws on third-party search providers, Bing among them. GPTBot only governs training.",
      zh: "ChatGPT 搜索只展示允许 OAI-SearchBot 抓取的网站，也会用到第三方搜索（包括 Bing）；GPTBot 只影响训练。",
    },
  },
  {
    id: "GOOGLE_AIO", name: "Google AI Overviews", nameZh: "Google AI 概览", vendor: "Google",
    crawlers: [GOOGLEBOT], controlTokens: [], eligibility: "GOOGLE", index: "GOOGLE", report: "GSC_AI",
    referrers: [],
    answers: { kind: "DATAFORSEO", endpoint: "GOOGLE_AI_OVERVIEW" },
    note: {
      en: "Built into Search: Googlebot rules and snippet controls (nosnippet, max-snippet, data-nosnippet) apply, plus the Search generative AI setting in Search Console. Google-Extended does not affect it. Clicks count as ordinary organic traffic.",
      zh: "属于 Google 搜索：受 Googlebot 规则、摘要控制（nosnippet、max-snippet、data-nosnippet）和 Search Console 的“生成式 AI”设置影响，Google-Extended 不影响它。点击计入普通自然搜索流量。",
    },
  },
  {
    id: "GOOGLE_AI_MODE", name: "Google AI Mode", nameZh: "Google AI 模式", vendor: "Google",
    crawlers: [GOOGLEBOT], controlTokens: [], eligibility: "GOOGLE", index: "GOOGLE", report: "GSC_AI",
    referrers: [],
    answers: { kind: "DATAFORSEO", endpoint: "GOOGLE_AI_MODE" },
    note: {
      en: "Same controls as AI Overviews. Search Console reports both together.",
      zh: "与 AI 概览相同的控制方式，Search Console 把两者合并报告。",
    },
  },
  {
    id: "GEMINI", name: "Gemini", nameZh: "Gemini", vendor: "Google",
    crawlers: [GOOGLEBOT], controlTokens: ["Google-Extended"], eligibility: "GOOGLE", index: "GOOGLE", report: null,
    referrers: ["Gemini"],
    answers: { kind: "DATAFORSEO", endpoint: "GEMINI_SCRAPER" },
    note: {
      en: "Gemini grounds answers in Google Search, but not with pages whose robots.txt disallows Google-Extended.",
      zh: "Gemini 用 Google 搜索为回答提供依据，但不会使用 robots.txt 禁止了 Google-Extended 的网页。",
    },
  },
  {
    id: "PERPLEXITY", name: "Perplexity", nameZh: "Perplexity", vendor: "Perplexity",
    crawlers: [
      { token: "PerplexityBot", role: "INDEX", userAgent: ua("PerplexityBot/1.0") },
      { token: "Perplexity-User", role: "USER", userAgent: ua("Perplexity-User/1.0") },
    ],
    controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Perplexity"],
    answers: { kind: "DATAFORSEO", endpoint: "PERPLEXITY_RESPONSES" },
    note: {
      en: "Perplexity answers from its own index built by PerplexityBot. Answers are read through the Sonar API, which is close to but not identical with the app.",
      zh: "Perplexity 用 PerplexityBot 建立的自有索引作答。答案通过 Sonar 接口获取，与 App 中看到的接近但不完全相同。",
    },
  },
  {
    id: "COPILOT", name: "Microsoft Copilot", nameZh: "Microsoft Copilot", vendor: "Microsoft",
    crawlers: [BINGBOT], controlTokens: [], eligibility: "BING", index: "BING", report: "BING_AI",
    referrers: ["Copilot"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Copilot grounds answers in the Bing index. NOARCHIVE keeps a page out of Copilot answers and NOCACHE limits it to the URL, title and snippet. Bing Webmaster Tools reports Copilot citations (AI Performance).",
      zh: "Copilot 用 Bing 索引作答。NOARCHIVE 会让页面不出现在 Copilot 回答中，NOCACHE 只允许使用网址、标题和摘要。Bing Webmaster Tools 的 AI Performance 报告会列出 Copilot 的引用。",
    },
  },
  {
    id: "CLAUDE", name: "Claude", nameZh: "Claude", vendor: "Anthropic",
    crawlers: [
      { token: "Claude-SearchBot", role: "INDEX", userAgent: ua("Claude-SearchBot/1.0") },
      { token: "Claude-User", role: "USER", userAgent: ua("Claude-User/1.0") },
      { token: "ClaudeBot", role: "TRAINING", userAgent: ua("ClaudeBot/1.0") },
    ],
    controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Claude"],
    answers: { kind: "DATAFORSEO", endpoint: "CLAUDE_RESPONSES" },
    note: {
      en: "Claude-SearchBot improves search results; ClaudeBot only governs training. Answers are read through the API with web search on.",
      zh: "Claude-SearchBot 用于改进搜索结果，ClaudeBot 只影响训练。答案通过开启网页搜索的接口获取。",
    },
  },
  {
    id: "GROK", name: "Grok", nameZh: "Grok", vendor: "xAI",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Grok"],
    answers: { kind: "MANUAL" },
    note: {
      en: "xAI publishes no crawler name to allow or block. Record answers by hand.",
      zh: "xAI 没有公布可在 robots.txt 中设置的爬虫名称。答案需要手动记录。",
    },
  },
  {
    id: "META_AI", name: "Meta AI", nameZh: "Meta AI", vendor: "Meta",
    crawlers: [
      { token: "Meta-ExternalAgent", role: "INDEX", userAgent: "meta-externalagent/1.1" },
      { token: "Meta-ExternalFetcher", role: "USER", userAgent: "meta-externalfetcher/1.1" },
    ],
    controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Meta AI"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Meta-ExternalAgent crawls for Meta's AI products and model training; Meta-ExternalFetcher fetches links people share. Record answers by hand.",
      zh: "Meta-ExternalAgent 为 Meta 的 AI 产品和模型训练抓取，Meta-ExternalFetcher 抓取用户分享的链接。答案需要手动记录。",
    },
  },
  {
    id: "DEEPSEEK", name: "DeepSeek", nameZh: "DeepSeek", vendor: "DeepSeek",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["DeepSeek"],
    answers: { kind: "MANUAL" },
    note: {
      en: "DeepSeek publishes no crawler name, and its API cannot search the web. Record answers by hand.",
      zh: "DeepSeek 没有公布爬虫名称，接口也不能联网搜索。答案需要手动记录。",
    },
  },
  /*
   * Assistants used in China. None of them offers an answer API that prompt
   * tracking could ask, or documents a crawler for its answers that the
   * access check could imitate, so answers are recorded by hand from each
   * app. Their referral names are the ones the GA4 import already uses
   * (lib/geo/import.ts), so referred sessions show up here too.
   */
  {
    id: "DOUBAO", name: "Doubao", nameZh: "豆包", vendor: "ByteDance",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Doubao"],
    answers: { kind: "MANUAL" },
    note: {
      en: "ByteDance documents no crawler for Doubao's answers. Record answers seen in the Doubao app or doubao.com by hand; GA4 sessions from doubao.com count as referrals.",
      zh: "字节跳动没有公布豆包回答所用的爬虫。请把在豆包 App 或 doubao.com 看到的回答手动记录；GA4 中来自 doubao.com 的会话计为引荐访问。",
    },
  },
  {
    id: "YUANBAO", name: "Tencent Yuanbao", nameZh: "腾讯元宝", vendor: "Tencent",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Yuanbao"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Tencent documents no crawler for Yuanbao's answers, which can draw on WeChat articles as well as the web. Record answers by hand; GA4 sessions from yuanbao.tencent.com count as referrals.",
      zh: "腾讯没有公布元宝回答所用的爬虫；元宝的回答除网页外也会引用微信公众号文章。请手动记录回答；GA4 中来自 yuanbao.tencent.com 的会话计为引荐访问。",
    },
  },
  {
    id: "QWEN", name: "Qwen", nameZh: "千问", vendor: "Alibaba",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Qwen"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Alibaba documents no crawler for Qwen's answers. Record answers from the Qwen app or chat.qwen.ai by hand; GA4 sessions from Qwen and Tongyi hosts count as referrals.",
      zh: "阿里巴巴没有公布千问（通义）回答所用的爬虫。请把在千问 App 或网页版看到的回答手动记录；GA4 中来自千问、通义域名的会话计为引荐访问。",
    },
  },
  {
    id: "KIMI", name: "Kimi", nameZh: "Kimi", vendor: "Moonshot AI",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["Kimi"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Moonshot AI documents no crawler for Kimi's answers. Record answers by hand; GA4 sessions from kimi.com and kimi.moonshot.cn count as referrals.",
      zh: "月之暗面没有公布 Kimi 回答所用的爬虫。请手动记录回答；GA4 中来自 kimi.com、kimi.moonshot.cn 的会话计为引荐访问。",
    },
  },
  {
    id: "ERNIE", name: "ERNIE Bot", nameZh: "文心一言", vendor: "Baidu",
    crawlers: [], controlTokens: [], eligibility: "GENERIC", index: null, report: null,
    referrers: ["ERNIE Bot"],
    answers: { kind: "MANUAL" },
    note: {
      en: "Baidu documents no separate crawler for ERNIE Bot's answers, and this tool does not read Baidu's index. Record answers by hand; GA4 sessions from yiyan.baidu.com count as referrals.",
      zh: "百度没有为文心一言的回答单独公布爬虫，本工具也不读取百度索引。请手动记录回答；GA4 中来自 yiyan.baidu.com 的会话计为引荐访问。",
    },
  },
];

const byId = new Map(GEO_PLATFORMS.map(p => [p.id, p]));
export function geoPlatform(id: string): GeoPlatform | null {
  return byId.get(id as GeoPlatformId) ?? null;
}
export function isGeoPlatformId(value: unknown): value is GeoPlatformId {
  return typeof value === "string" && byId.has(value as GeoPlatformId);
}
/** Platforms prompt tracking can query through DataForSEO. */
export const TRACKED_PLATFORMS: readonly GeoPlatformId[] = GEO_PLATFORMS.filter(p => p.answers.kind === "DATAFORSEO").map(p => p.id);
/**
 * Search engine crawlers the live access check does not imitate. Their
 * operators publish how to verify them and firewalls commonly block, or ban
 * for a while, requests that claim to be them from other addresses; Search
 * Console and Bing Webmaster Tools report how the real ones fare.
 */
export const UNPROBED_CRAWLERS: readonly string[] = ["Googlebot", "Bingbot"];

/** The crawlers the access check requests with, once each. */
export function probeCrawlers(): PlatformCrawler[] {
  const seen = new Map<string, PlatformCrawler>();
  for (const platform of GEO_PLATFORMS) {
    for (const crawler of platform.crawlers) {
      if (!seen.has(crawler.token) && !UNPROBED_CRAWLERS.includes(crawler.token)) seen.set(crawler.token, crawler);
    }
  }
  return [...seen.values()];
}
