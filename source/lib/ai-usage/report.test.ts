import { describe, expect, it } from "vitest";
import { buildUsageReport, type UsageTask } from "./report";
import { aiUsageSchema } from "./schema";

const now = new Date("2026-11-06T08:00:00Z");
function task(values: Partial<UsageTask> = {}): UsageTask {
  return { id: "job", title: "A draft", domain: "example.test", kind: "WRITE_ARTICLE", status: "SUCCEEDED", provider: "CHATGPT_APP", model: "test-model",
    createdAt: now.toISOString(), startedAt: now.toISOString(), finishedAt: now.toISOString(), usage: null, ...values };
}
describe("local task usage reporting", () => {
  it("shows unknown rather than zero for an empty or uninstrumented period", () => {
    expect(buildUsageReport([], 30, null, now).summary).toMatchObject({ tasks: 0, withUsage: 0, withoutUsage: 0, totalTokens: null });
    const report = buildUsageReport([task(), task({ id: "old", status: "FAILED" })], 7, "site", now);
    expect(report.summary).toMatchObject({ tasks: 2, succeeded: 1, failed: 1, withUsage: 0, withoutUsage: 2, inputTokens: null, totalTokens: null });
    expect(report.quota).toEqual({ available: false, manageUrl: "https://chatgpt.com/settings/usage" });
  });
  it("counts failed tasks with reported usage and sums each reported field only once", () => {
    const report = buildUsageReport([
      task({ usage: aiUsageSchema.parse({ source: "CHATGPT_RESPONSE", inputTokens: 100, cachedInputTokens: 80, outputTokens: 50, reasoningTokens: 20, totalTokens: 150 }) }),
      task({ id: "failed", status: "FAILED", provider: "CODEX_LOCAL", usage: aiUsageSchema.parse({ source: "CODEX_CLI", inputTokens: 20, outputTokens: 0, totalTokens: 20 }) }),
      task({ id: "partial", usage: aiUsageSchema.parse({ source: "CHATGPT_RESPONSE", inputTokens: 3 }) }), task({ id: "old" }),
    ], 30, null, now);
    expect(report.summary).toMatchObject({ tasks: 4, withUsage: 3, withoutUsage: 1, inputTokens: 123, cachedInputTokens: 80, outputTokens: 50, reasoningTokens: 20, totalTokens: 170 });
    expect(report.providers).toEqual([{ provider: "CHATGPT_APP", tasks: 3, withUsage: 2, totalTokens: 150 }, { provider: "CODEX_LOCAL", tasks: 1, withUsage: 1, totalTokens: 20 }]);
  });
  it("rejects provider mismatches and limits details without truncating summary", () => {
    const forged = task({ usage: aiUsageSchema.parse({ source: "CODEX_CLI", totalTokens: 99 }) });
    const report = buildUsageReport([forged, ...Array.from({ length: 24 }, (_, i) => task({ id: `job${i}` }))], 90, null, now);
    expect(report.summary).toMatchObject({ tasks: 25, withUsage: 0, totalTokens: null });
    expect(report.recent).toHaveLength(20);
  });
});
