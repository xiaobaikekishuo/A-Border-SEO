import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { I18nProvider } from "@/lib/i18n/client";
import type { AiUsageReport } from "@/lib/ai-usage/report";
import { UsagePanel, UsageReportView } from "./usage-panel";

const unknownReport: AiUsageReport = {
  period: { days: 30, start: "2026-10-07T00:00:00Z", end: "2026-11-06T00:00:00Z" },
  scope: { siteId: "site1" }, quota: { available: false, manageUrl: "https://chatgpt.com/settings/usage" },
  summary: { tasks: 1, succeeded: 1, failed: 0, queued: 0, running: 0, withUsage: 0, withoutUsage: 1,
    inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null },
  providers: [{ provider: "CHATGPT_APP", tasks: 1, withUsage: 0, totalTokens: null }],
  recent: [{ id: "aw_one", kind: "WRITE_ARTICLE", title: "Historical article", domain: "site.test", provider: "CHATGPT_APP", model: null,
    createdAt: "2026-11-05T00:00:00Z", startedAt: null, finishedAt: "2026-11-05T00:01:00Z", status: "SUCCEEDED", usage: null }],
};

describe("A-Border SEO usage presentation", () => {
  it.each([["KEYWORD_RESEARCH", "关键词研究"], ["DOMAIN_ANALYSIS", "域名诊断"], ["BACKLINK_ANALYSIS", "链接分析"]])("identifies %s tasks in the shared account usage report", (kind, label) => {
    const report = { ...unknownReport, recent: [{ ...unknownReport.recent[0], kind }] };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><UsageReportView report={report} /></I18nProvider>);
    expect(html).toContain(label);
    expect(html).toContain("未知</strong>");
  });
  it("does not present a successful historical task as zero tokens", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><UsageReportView report={unknownReport} /></I18nProvider>);
    expect(html).toContain("已记录总 Token");
    expect(html).toContain("未知</strong>");
    expect(html).toContain("1 个任务没有 Token 记录");
    expect(html).toContain("不按零处理");
    expect(html).toContain("任务数不等于 API 调用次数");
    expect(html).toContain("模型未记录");
  });

  it("shows reported token counts for failed tasks and preserves a true zero", () => {
    const report: AiUsageReport = { ...unknownReport,
      summary: { ...unknownReport.summary, succeeded: 0, failed: 1, withUsage: 1, withoutUsage: 0, inputTokens: 1200, cachedInputTokens: 400, outputTokens: 0, totalTokens: 1200 },
      recent: [{ ...unknownReport.recent[0], status: "FAILED", model: "fixture-model", usage: { source: "CHATGPT_RESPONSE", inputTokens: 1200, cachedInputTokens: 400, outputTokens: 0, reasoningTokens: null, totalTokens: 1200 } }],
    };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><UsageReportView report={report} /></I18nProvider>);
    expect(html).toContain("Failed / canceled");
    expect(html).toContain("1,200</td>");
    expect(html).toContain(">0</td>");
    expect(html).toContain("Includes cached input");
    expect(html).toContain("Sums only reported total-token values");
    expect(html).toContain("This is not your plan usage percentage");
    expect(html).toContain("may not add up to the total-token card");
  });

  it("provides official quota management and clearly scopes statistics before data loads", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><UsagePanel siteId="site1" refreshKey="" /></I18nProvider>);
    expect(html).toContain('href="https://chatgpt.com/settings/usage"');
    expect(html).toContain("本平台用量统计");
    expect(html).toContain("包含不同 ChatGPT 连接");
    expect(html).toContain("不能直接换算为套餐剩余额度或费用");
    expect(html).toContain("正在读取用量记录");
    expect(html).not.toContain("已记录总 Token");
  });
});
