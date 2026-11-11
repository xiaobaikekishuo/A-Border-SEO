import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { I18nProvider } from "@/lib/i18n/client";
import { AiAccessPanel, AiAccessResults } from "./ai-access-panel";
import type { AiAccessBot, AiAccessReport } from "@/lib/seo/ai-access-types";

const bot = (agent: string, patch: Partial<AiAccessBot> = {}): AiAccessBot => ({
  agent, provider: "OpenAI", purpose: "TRAINING", kind: "CRAWLER", robots: "UNKNOWN", declared: null, group: null, matchedLine: null, rule: null, crawlDelay: null, ...patch,
});
const report: AiAccessReport = {
  siteId: "site-a", url: "https://example.test/article", checkedAt: "2026-11-06T00:00:00Z",
  robots: { url: "https://example.test/robots.txt", finalUrl: "https://example.test/robots.txt", status: 200, outcome: "UNKNOWN", reason: "HTML_RESPONSE", contentType: "text/html", sitemaps: [] },
  bots: [
    bot("GPTBot"),
    bot("ChatGPT-User", { purpose: "USER_REQUEST", robots: "NOT_APPLICABLE" }),
  ], preferences: [], page: null, limits: { robotsMaxBytes: 512000, timeoutMs: 15000 },
  warnings: ["ROBOTS_NOT_PROOF_OF_ACCESS", "SAVED_PAGE_NOT_LIVE"],
};

describe("AI access evidence presentation", () => {
  it("starts without a result and requires an explicit check", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><AiAccessPanel siteId="site-a" domain="example.test" initialUrl="https://example.test/" /></I18nProvider>);
    expect(html).toContain("检查访问规则");
    expect(html).toContain("不消耗模型额度");
    expect(html).not.toContain("规则检查结果");
  });
  it("distinguishes unknown robots, historical page absence and user visits", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><AiAccessResults report={report} /></I18nProvider>);
    expect(html).toContain("无法判断");
    expect(html).toContain("不能用 robots 判断");
    expect(html).toContain("HTML 页面而非 robots.txt");
    expect(html).toContain("没有保存此网址的页面依据");
    expect(html).not.toContain("HTML_RESPONSE");
    expect(html).not.toContain("规则允许");
  });
  it("explains RFC 9309 outcomes for unavailable and unreachable files", () => {
    const unavailable: AiAccessReport = { ...report, robots: { ...report.robots, status: 404, outcome: "UNAVAILABLE", reason: "ROBOTS_NOT_FOUND" }, bots: [bot("GPTBot", { robots: "ALLOWED", declared: "ALLOWED" })] };
    const zh = renderToStaticMarkup(<I18nProvider initialLocale="zh"><AiAccessResults report={unavailable} /></I18nProvider>);
    expect(zh).toContain("不可用：视为全部允许");
    expect(zh).toContain("规则允许");
    const unreachable: AiAccessReport = { ...report, robots: { ...report.robots, status: 503, outcome: "UNREACHABLE", reason: "ROBOTS_SERVER_ERROR" }, bots: [bot("GPTBot", { robots: "BLOCKED", declared: "BLOCKED" })] };
    const en = renderToStaticMarkup(<I18nProvider initialLocale="en"><AiAccessResults report={unreachable} /></I18nProvider>);
    expect(en).toContain("Unreachable: all disallowed");
    expect(en).toContain("must assume everything is disallowed");
  });
  it("labels the shared training token and declared content preferences", () => {
    const withPolicy: AiAccessReport = {
      ...report,
      robots: { ...report.robots, outcome: "RULES", reason: null, contentType: "text/plain" },
      bots: [
        bot("__usage_ai-training", { provider: "Shared", kind: "POLICY_TOKEN", robots: "BLOCKED", declared: "BLOCKED", group: "__usage_ai-training", matchedLine: 2, rule: "Disallow: /" }),
        bot("Google-Extended", { provider: "Google", kind: "CONTROL_TOKEN", robots: "ALLOWED", declared: "ALLOWED", group: "*" }),
      ],
      preferences: [{ kind: "CONTENT_SIGNAL", scope: ["*"], path: null, values: { search: "yes", "ai-train": "no" }, line: 5, text: "Content-Signal: search=yes, ai-train=no" }],
      warnings: [...report.warnings, "PREFERENCES_ARE_REQUESTS"],
    };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><AiAccessResults report={withPolicy} /></I18nProvider>);
    expect(html).toContain("此路径已声明拒绝训练");
    expect(html).toContain("共享 AI 训练偏好");
    expect(html).toContain("控制标记，没有独立爬虫");
    expect(html).toContain("使用分组：User-agent *");
    expect(html).toContain("Content-Signal: search=yes, ai-train=no");
    expect(html).toContain("不会阻止抓取");
  });
  it("keeps recorded noindex scoped and renders rule text inertly", () => {
    const recorded: AiAccessReport = { ...report, robots: { ...report.robots, outcome: "RULES", reason: null }, page: { source: "SAVED_CRAWL", capturedAt: "2026-11-01T00:00:00Z", url: report.url, statusCode: 200, indexable: false, robotsMeta: "noindex", xRobotsTag: null }, bots: [bot("ClaudeBot", { provider: "Anthropic", robots: "BLOCKED", declared: "BLOCKED", group: "ClaudeBot", matchedLine: 3, rule: 'Disallow: /<script>alert(1)</script>' })] };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><AiAccessResults report={recorded} /></I18nProvider>);
    expect(html).toContain("does not decide every AI provider");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Rules disallow");
  });
});
