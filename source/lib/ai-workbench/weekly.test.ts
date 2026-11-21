import { describe, expect, it } from "vitest";
import { weekSlot, weeklyReportTitle } from "./weekly-report";
import { weeklyReportEmail, weeklyReportPayload, type WeeklyReport } from "./weekly-delivery";

const report: WeeklyReport = {
  jobId: "aw_1", siteId: "site_1", userId: "user_1", domain: "shop.test", title: "本周行动清单（自动）", language: "zh-CN",
  finishedAt: "2026-11-23T02:00:00.000Z", period: { start: "2026-11-09", end: "2026-11-15" }, summary: "Two pages lost clicks.",
  actions: [
    { title: "Rewrite the <b>cases</b> title", reason: "CTR 0.4% at position 4", nextStep: "Use the query in the title", verify: "Compare clicks in 3 weeks" },
    { title: "Fix 404 links", reason: "12 broken links", nextStep: "Redirect them", verify: "Recrawl" },
  ],
};

describe("weekly slot", () => {
  it("starts each week on Monday 00:00 UTC", () => {
    expect(weekSlot(new Date("2026-11-23T00:00:00.000Z")).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(weekSlot(new Date("2026-11-22T23:59:59.999Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(weekSlot(new Date("2026-11-20T12:30:00.000Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(weekSlot(new Date("2027-01-01T08:00:00.000Z")).toISOString()).toBe("2026-12-28T00:00:00.000Z");
  });
  it("names the report in its language", () => {
    expect(weeklyReportTitle("zh-TW")).toBe("本周行动清单（自动）");
    expect(weeklyReportTitle("en")).toBe("Weekly action list (scheduled)");
  });
});

describe("weekly delivery", () => {
  it("writes one email with every action, escaped, in the report's language", () => {
    const message = weeklyReportEmail(["owner@shop.test"], report);
    expect(message.to).toEqual(["owner@shop.test"]);
    expect(message.subject).toBe("[A-Border SEO] 本周行动清单：shop.test");
    expect(message.text).toContain("1. Rewrite the <b>cases</b> title");
    expect(message.text).toContain("下一步: Redirect them");
    expect(message.text).toContain("数据时段 2026-11-09 至 2026-11-15");
    expect(message.html).toContain("Rewrite the &lt;b&gt;cases&lt;/b&gt; title");
    expect(message.html).not.toContain("<b>cases</b>");
    const english = weeklyReportEmail(["owner@shop.test"], { ...report, language: "en", domain: "shop.test\nBcc: x@evil.test" });
    expect(english.subject).toBe("[A-Border SEO] Weekly action list: shop.test Bcc: x@evil.test");
    expect(english.text).toContain("How to verify: Recrawl");
  });
  it("sends a report.weekly webhook body", () => {
    expect(weeklyReportPayload("job_9", report)).toMatchObject({ event: "report.weekly", id: "job_9", generatedAt: "2026-11-23T02:00:00.000Z",
      site: { id: "site_1", domain: "shop.test" }, report: { jobId: "aw_1", period: { start: "2026-11-09", end: "2026-11-15" }, actions: report.actions },
      app: { name: "a-border-seo" } });
  });
});
