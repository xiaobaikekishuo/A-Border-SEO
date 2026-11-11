import { describe, expect, it } from "vitest";
import { classifyAiSource, normalizeGeoDay, normalizeGeoPath, parseGeoImport } from "./import";

const domain = "site.example";
const csvHeader = "Date,Session source / medium,Landing page + query string,Sessions,Host name";
const log = (ua = "GPTBot/1.2", path = "/guide?token=secret", date = "01/Mar/2024:01:00:00 +0800") =>
  `203.0.113.15 - user [${date}] "GET ${path} HTTP/1.1" 200 123 "https://ref.example/id" "${ua}"`;

describe("GA4 referral import", () => {
  it("reads GA4 exports with metadata, BOM, quotes, Unicode labels and optional hostname", () => {
    const text = "\uFEFF# GA4 export\r\n# Start Date: 20260301\r\n\r\n日期,会话来源/媒介,着陆页 + 查询字符串,会话数,主机名\r\n" +
      '20260302,chatgpt.com / referral,"/a,b?q=private","1,234",site.example\r\n' +
      '2026-03-02,CHATGPT / referral,"/a,b",1,site.example\r\n' +
      "20260302,google / organic,/,3,site.example\r\n" +
      "20260302,claude.ai / referral,/,10,other.example\r\n" +
      '20260302,claude.ai / referral,"https://other.example/a",10,site.example\r\n';
    expect(parseGeoImport("GA4", text, domain)).toEqual({
      processed: 5, skipped: 3, rows: [{ day: "2026-03-02", platform: "ChatGPT", path: "/a,b", count: 1235 }],
    });
    expect(parseGeoImport("GA4", "Date,Session source,Landing page,Sessions\n20260302,claude.ai,(not set),0", domain).rows)
      .toEqual([{ day: "2026-03-02", path: "(not set)", platform: "Claude", count: 0 }]);
  });
  it("ignores ordinary traffic and accepts only known attribution sources", () => {
    const r = parseGeoImport("GA4", csvHeader + "\n20260302,google / organic,/,400,site.example", domain);
    expect(r).toEqual({ rows: [], processed: 1, skipped: 1 });
    expect(classifyAiSource("https://www.perplexity.ai/search/test")).toBe("Perplexity");
    expect(classifyAiSource("copilot.microsoft.com / referral")).toBe("Copilot");
    for (const source of ["evil.chatgpt.com.example", "chatgpt.com.example / referral", "totally-not-claude", "bing.com", "(direct)", "https://x:y@claude.ai"])
      expect(classifyAiSource(source)).toBeNull();
  });
  it("recognizes newer assistants, including Chinese ones, without claiming search engines", () => {
    expect(classifyAiSource("grok.com / referral")).toBe("Grok");
    expect(classifyAiSource("https://www.meta.ai/")).toBe("Meta AI");
    expect(classifyAiSource("chat.mistral.ai / referral")).toBe("Mistral");
    expect(classifyAiSource("edgeservices.bing.com / referral")).toBe("Copilot");
    expect(classifyAiSource("www.qianwen.com / referral")).toBe("Qwen");
    expect(classifyAiSource("tongyi.aliyun.com / referral")).toBe("Qwen");
    expect(classifyAiSource("yiyan.baidu.com / referral")).toBe("ERNIE Bot");
    expect(classifyAiSource("yuanbao.tencent.com / referral")).toBe("Yuanbao");
    expect(classifyAiSource("chatglm.cn / referral")).toBe("ChatGLM");
    expect(classifyAiSource("metaso / referral")).toBe("Metaso");
    for (const source of ["baidu.com / organic", "duckduckgo.com / organic", "tencent.com / referral", "aliyun.com / referral"]) expect(classifyAiSource(source)).toBeNull();
  });
  it("rejects unusable headers, corrupt input, wrong sites, excessive aggregate counts", () => {
    expect(() => parseGeoImport("GA4", "Date,Sessions\n20260301,12", domain)).toThrow("geo_csv_headers");
    expect(() => parseGeoImport("GA4", 'Date,Session source,Landing page,"Sessions', domain)).toThrow("geo_csv_invalid");
    expect(() => parseGeoImport("GA4", csvHeader + "\n20260302,chatgpt.com,/,40,other.example", domain)).toThrow("geo_no_valid_rows");
    expect(() => parseGeoImport("GA4", csvHeader + "\n20260231,chatgpt.com,/,40,site.example", domain)).toThrow("geo_no_valid_rows");
    expect(() => parseGeoImport("GA4", csvHeader + "\n20260302,chatgpt.com,/,2147483647,site.example\n20260302,chatgpt.com,/,1,site.example", domain)).toThrow("geo_count_limit");
    expect(() => parseGeoImport("GA4", "Date,Date,Session source,Landing page,Sessions", domain)).toThrow("geo_csv_headers");
  });
});

describe("declared bot requests", () => {
  it("uses the access log offset, retains distinct purposes, and discards identity and query fields", () => {
    const rows = [
      log("Mozilla/5.0 (compatible; OAI-SearchBot/1.2; +https://openai.com/searchbot)"),
      log("GPTBot/1.2"), log("GPTBot/1.2"), log("ChatGPT-User/1.0"),
      "other.example " + log("GPTBot/1.2"), log("not-GPTBot/1.2"), log("GPTBot-Fake"),
      log("Mozilla/5.0 (https://example.com/GPTBot/1.2)"), log("ClaudeBot/1.0", "https://unrelated.example/data"),
    ];
    const snapshot = parseGeoImport("BOT", rows.join("\n"), domain);
    expect(snapshot.processed).toBe(9);
    expect(snapshot.skipped).toBe(5);
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.rows).toContainEqual({ day: "2024-02-29", platform: "OpenAI · GPTBot", path: "/guide", count: 2 });
    expect(snapshot.rows.every(row => row.path === "/guide")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/203\.0\.113|token|secret|ref\.example/);
  });
  it("requires a recognized log shape and rejects malformed dates", () => {
    expect(() => parseGeoImport("BOT", log("GPTBot/1.2", "/", "31/Feb/2024:10:00:00 +0800"), domain)).toThrow("geo_no_valid_rows");
    expect(() => parseGeoImport("BOT", "123 GPTBot https://site.example", domain)).toThrow("geo_no_valid_rows");
    expect(parseGeoImport("BOT", "site.example " + log("Perplexity-User/1.0"), domain).rows[0].platform).toBe("Perplexity · Perplexity-User");
  });
  it("counts the wider set of AI crawlers but not search engines or control tokens", () => {
    const platform = (ua: string) => parseGeoImport("BOT", log(ua), domain).rows[0]?.platform;
    expect(platform("Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)")).toBe("ByteDance · Bytespider");
    expect(platform("CCBot/2.0 (https://commoncrawl.org/faq/)")).toBe("Common Crawl · CCBot");
    expect(platform("meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)")).toBe("Meta · Meta-ExternalAgent");
    expect(platform("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1)")).toBe("Amazon · Amazonbot");
    expect(platform("DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)")).toBe("DuckDuckGo · DuckAssistBot");
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Google-Extended", "__usage_ai-training"])
      expect(parseGeoImport("BOT", log(ua), domain).rows, ua).toEqual([]);
  });
});

describe("bounded, redacted input", () => {
  it("enforces byte and line limits", () => {
    expect(() => parseGeoImport("BOT", "文".repeat(349526), domain)).toThrow("geo_too_large");
    expect(() => parseGeoImport("BOT", Array(10001).fill("abc").join("\n"), domain)).toThrow("geo_too_many_lines");
  });
  it("strips common personal identifiers; prevents unsafe and cross-host paths", () => {
    for (const path of ["/account/personal-id", "/id/person%40example.com", "/order/123456789", "/user/jane", "/p/12345678-1234-1234-abcd-a23456210345"])
      expect(normalizeGeoPath(path, domain)).toBe("/[private]");
    for (const path of ["/a%252fb", "//foreign.com/x", "https://pass@site.example/x", "https://www.site.example/x", "/a%3Fb", "/%00"])
      expect(normalizeGeoPath(path, domain)).toBeNull();
    expect(normalizeGeoPath("https://site.example/page?private=1#fragment", domain)).toBe("/page");
    expect(normalizeGeoDay("2024-0229")).toBeNull();
  });
});
