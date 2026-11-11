import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { KeywordAiPanel } from "./keyword-ai-panel";
import { KeywordResearchClient } from "./keyword-research-client";
import { ManusKeywordPanel, ManusTaskResult } from "./manus-keyword-panel";
import type { ManusKeywordTask } from "@/lib/manus/tasks";
import { canGenerateKeywords, keywordTaskPayload, visibleKeywordIdeas, type KeywordInput, type KeywordWorkspace } from "./keyword-ai-model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/ai-workbench/chatgpt-connection", () => ({
  ChatGPTConnection: ({ appOnly, returnPage }: { appOnly: boolean; returnPage: string }) => <div data-account-only={appOnly} data-return={returnPage}>Connection</div>,
}));
afterEach(() => vi.unstubAllGlobals());
const input: KeywordInput = { seed: "  Apple ID 地区  ", targetMarket: "  中国大陆新手  ", count: 12, language: "zh-CN", instructions: "  操作前核对事项  " };
const execution = { provider: "CHATGPT_APP" as const, ready: true, profileId: "profile", model: "model", planOnlyConfirmed: true };
const state = { online: true, active: false, busy: false, loading: false, uncertain: false };
const workspace: KeywordWorkspace = {
  site: { id: "site", domain: "example.test" }, worker: { online: true }, activeTask: null,
  jobs: [{ id: "aw_one", kind: "KEYWORD_RESEARCH", title: "Apple ID 地区", status: "SUCCEEDED", createdAt: "2026-11-06T04:00:00Z", updatedAt: "2026-11-06T04:01:00Z", error: null,
    result: { summary: "用地区切换前的问题组织内容", factChecks: ["请验证读者需求"], keywordIdeas: [
      { keyword: "Apple ID 地区是什么", intent: "INFORMATIONAL", funnel: "TOFU", cluster: "账号地区", angle: "解释账号地区的用途", rationale: "读者需要先理解概念" },
      { keyword: "更换 Apple ID 地区前检查什么", intent: "TRANSACTIONAL", funnel: "BOFU", cluster: "切换准备", angle: "整理操作前检查清单", rationale: "适合已有明确操作意图的读者" },
    ] } }],
};
describe("keyword suggestion generation boundaries", () => {
  it("requires confirmed app access, valid input and an idle live worker", () => {
    expect(canGenerateKeywords(input, execution, state)).toBe(true);
    for (const key of ["active", "busy", "loading", "uncertain"] as const) expect(canGenerateKeywords(input, execution, { ...state, [key]: true })).toBe(false);
    expect(canGenerateKeywords(input, execution, { ...state, online: false })).toBe(false);
    expect(canGenerateKeywords(input, { ...execution, provider: "CODEX_LOCAL" }, state)).toBe(false);
    expect(canGenerateKeywords(input, { ...execution, ready: false }, state)).toBe(false);
    expect(canGenerateKeywords(input, { ...execution, planOnlyConfirmed: false }, state)).toBe(false);
    expect(canGenerateKeywords(input, { ...execution, profileId: undefined }, state)).toBe(false);
    expect(canGenerateKeywords(input, { ...execution, model: undefined }, state)).toBe(false);
    expect(canGenerateKeywords({ ...input, seed: " " }, execution, state)).toBe(false);
    expect(canGenerateKeywords({ ...input, targetMarket: " " }, execution, state)).toBe(false);
    expect(canGenerateKeywords({ ...input, targetMarket: "x".repeat(121) }, execution, state)).toBe(false);
  });
  it("builds an account-only bounded task with no paid research or article payload", () => {
    expect(keywordTaskPayload(input, execution)).toEqual({ action: "start", kind: "KEYWORD_RESEARCH", provider: "CHATGPT_APP", profileId: "profile", model: "model", planOnlyConfirmed: true,
      title: "Apple ID 地区", keyword: "Apple ID 地区", language: "zh-CN", instructions: "操作前核对事项", keywordResearch: { count: 12, targetMarket: "中国大陆新手" } });
  });
  it("only exposes completed keyword candidates and combines funnel and text filters", () => {
    const job = workspace.jobs[0];
    expect(visibleKeywordIdeas(job, " APPLE ID ", "TOFU")).toHaveLength(1);
    expect(visibleKeywordIdeas(job, "切换准备", "BOFU")[0].keyword).toContain("前检查");
    expect(visibleKeywordIdeas(job, "账号地区", "BOFU")).toEqual([]);
    expect(visibleKeywordIdeas({ ...job, status: "FAILED" }, "", "")).toEqual([]);
    expect(visibleKeywordIdeas({ ...job, kind: "WRITE_ARTICLE" }, "", "")).toEqual([]);
  });
});
describe("keyword suggestion review UI", () => {
  it("defaults to data sources and performs no request during initial render", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><KeywordResearchClient siteId="site" hasDataForSEO={true} /></I18nProvider>);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("现有数据与联想词");
    expect(html).toContain("ChatGPT 关键词建议");
    expect(html).toContain("Manus 深度研究");
    expect(html).not.toContain("开始 Manus 研究");
    expect(html).not.toContain("Connection");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("presents ideas as inferred suggestions and never turns unknown metrics into zero", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><KeywordAiPanel siteId="site" initialData={workspace} /></I18nProvider>);
    for (const text of ["搜索量 / 难度 / CPC", "未知", "不是实测需求或排名预测", "建议理由（AI 判断）", "保存关键词", "全部漏斗阶段", "账号地区", "请验证读者需求"]) expect(html).toContain(text);
    expect(html).toContain('data-account-only="true"');
    expect(html).toContain('data-return="keyword-research"');
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("0 搜/月");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("supports English and reports a different active workbench task", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><KeywordAiPanel siteId="site" initialData={{ ...workspace, activeTask: { id: "other", kind: "WRITE_ARTICLE", title: "Article" } }} /></I18nProvider>);
    expect(html).toContain("A workbench task is active for this site");
    expect(html).toContain("Search volume, difficulty and CPC are unknown here");
    expect(html).toContain("Generate with ChatGPT plan");
    expect(html).toContain('type="submit"');
    expect(html).toMatch(/type="submit"[^>]+disabled=""/);
  });
});

describe("Manus keyword research UI", () => {
  it("offers per-task consent, a disabled submit and the account key settings link on entry", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><ManusKeywordPanel siteId="site" /></I18nProvider>);
    expect(html).toContain("/settings?connect=manus#connection-manus");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toMatch(/type="checkbox"[^>]+checked/);
    expect(html).toContain("使用我的 Manus 账号积分执行本次研究");
    expect(html).toMatch(/type="submit"[^>]+disabled/);
  });
  it("displays the saved summary as text and links only to HTTPS results", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const task: ManusKeywordTask = {
      id: "task", requestId: "req", createdAt: "2026-11-05T12:00:00Z", updatedAt: "2026-11-05T12:01:00Z",
      input: { seeds: ["SEO"], language: "English", audience: "US" }, status: "completed", refreshable: true,
      taskUrl: "https://example.test/app/task", errorCode: null, result: "<script>from task</script> [Download](sandbox:/mnt/data/research.xlsx)",
      files: [{ name: "keywords.xlsx", url: "https://example.test/file" }, { name: "unsafe.xlsx", url: "javascript:alert(1)" }],
    };
    const html = renderToStaticMarkup(<ManusTaskResult task={task} siteId="site" connected={false} busy={false} updating={false} onUpdate={() => {}} />);
    expect(html).toContain("&lt;script&gt;from task&lt;/script&gt;");
    expect(html).toContain("keywords.xlsx");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("sandbox:/");
    expect(html).toContain("research.xlsx (file in Manus)");
    expect(html).toContain("Load keywords from task");
    expect(html).toContain("Upload .xlsx");
    expect(html).toContain("Read full report");
    expect(html).toContain('aria-controls="manus-report-task"');
    expect(html).toContain("Open private task in Manus");
    expect(html).toMatch(/<button[^>]+disabled/);
    expect(fetch).not.toHaveBeenCalled();
    const running = renderToStaticMarkup(<ManusTaskResult task={{ ...task, status: "running" }} siteId="site" connected busy={false} updating={false} onUpdate={() => {}} />);
    expect(running).not.toContain("Read full report");
    expect(running).not.toContain("Load keywords from task");
  });
});
