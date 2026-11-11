import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { DomainCard, DomainOverviewClient } from "./domain-overview-client";
import { BacklinksClient, backlinkSourceLabel } from "./backlinks-client";
import { ResearchAiPanel } from "./research-ai-panel";
import { backlinkSampleShape, canGenerateResearch, researchFilename, researchReport, researchTaskPayload, type ResearchInput, type ResearchWorkspace } from "./research-ai-model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/ai-workbench/chatgpt-connection", () => ({ ChatGPTConnection: ({ appOnly, returnPage }: { appOnly: boolean; returnPage: string }) => <div data-account-only={appOnly} data-return={returnPage}>Connection</div> }));
afterEach(() => vi.unstubAllGlobals());
const input: ResearchInput = { title: "  Site review  ", targetMarket: "  UK beginners  ", language: "en", instructions: "  Prioritize fixes  ", body: "https://news.example.com/a\thttps://example.com/topic\tTopic" };
const execution = { provider: "CHATGPT_APP" as const, ready: true, profileId: "profile", model: "model", planOnlyConfirmed: true };
const state = { online: true, active: false, busy: false, loading: false, uncertain: false };
const workspace: ResearchWorkspace = {
  site: { id: "site", domain: "example.com" }, worker: { online: true }, activeTask: null,
  jobs: [{ id: "aw_analysis", kind: "BACKLINK_ANALYSIS", title: "链接诊断", status: "SUCCEEDED", createdAt: "2026-11-06T04:00:00Z", updatedAt: "2026-11-06T04:01:00Z", error: null,
    result: { summary: "先核对样本", contentMarkdown: '<img src=x onerror="alert(1)">\nReview B1 before making changes.', changeNotes: ["人工验证目标页面"], factChecks: ["样本未核验，不代表全部反链"] },
    researchEvidence: { kind: "BACKLINK_ANALYSIS", domain: "example.com", sources: { crawl: null, gsc: null, pastedBacklinks: { count: 1, verified: false } },
      counters: { sampledPages: 0, outgoingLinks: null, sampledOutgoingLinks: 0, backlinkSample: 1, totalBacklinks: null }, pages: [],
      links: [{ id: "B1", direction: "INCOMING_SAMPLE", sourceUrl: "https://news.example.com/a", targetUrl: "https://example.com/topic", anchorText: "Topic", nofollow: null, verified: false }], limitations: ["样本来源由用户提供"] } }],
};
describe("research tasks and account boundaries", () => {
  it("requires an eligible connected account, valid input and an idle worker", () => {
    expect(canGenerateResearch("DOMAIN_ANALYSIS", input, execution, state)).toBe(true);
    for (const flag of ["active", "busy", "loading", "uncertain"] as const) expect(canGenerateResearch("DOMAIN_ANALYSIS", input, execution, { ...state, [flag]: true })).toBe(false);
    for (const missing of [{ provider: "CODEX_LOCAL" as const }, { ready: false }, { profileId: undefined }, { model: undefined }, { planOnlyConfirmed: false }]) expect(canGenerateResearch("BACKLINK_ANALYSIS", input, { ...execution, ...missing }, state)).toBe(false);
    expect(canGenerateResearch("DOMAIN_ANALYSIS", input, execution, { ...state, online: false })).toBe(false);
    expect(canGenerateResearch("DOMAIN_ANALYSIS", { ...input, title: " " }, execution, state)).toBe(false);
    expect(canGenerateResearch("DOMAIN_ANALYSIS", { ...input, targetMarket: "x".repeat(121) }, execution, state)).toBe(false);
    expect(canGenerateResearch("BACKLINK_ANALYSIS", { ...input, body: "no tabs" }, execution, state)).toBe(false);
  });
  it("never attaches pasted links to a domain task and keeps links optional for backlink analysis", () => {
    const base = { action: "start", kind: "DOMAIN_ANALYSIS", provider: "CHATGPT_APP", profileId: "profile", model: "model", planOnlyConfirmed: true,
      title: "Site review", language: "en", instructions: "Prioritize fixes", researchAnalysis: { targetMarket: "UK beginners" } };
    expect(researchTaskPayload("DOMAIN_ANALYSIS", input, execution)).toEqual(base);
    expect(researchTaskPayload("BACKLINK_ANALYSIS", input, execution)).toEqual({ ...base, kind: "BACKLINK_ANALYSIS", body: input.body });
    expect(researchTaskPayload("BACKLINK_ANALYSIS", { ...input, body: " " }, execution)).not.toHaveProperty("body");
  });
  it("limits pasted sample shape without fetching or pretending to verify URLs", () => {
    expect(backlinkSampleShape("")).toBeNull();
    expect(backlinkSampleShape(`${input.body}\n\nhttps://source.example/path\thttps://example.com/x`)).toBeNull();
    expect(backlinkSampleShape(Array(51).fill(input.body).join("\n"))).toBe("rows");
    expect(backlinkSampleShape("x".repeat(24001))).toBe("length");
    expect(backlinkSampleShape("URL,URL,anchor")).toBe("columns");
    expect(backlinkSampleShape("\ttarget\tanchor")).toBe("columns");
    expect(backlinkSampleShape("source\ttarget\tanchor\textra")).toBe("columns");
  });
  it("offers only a completed report of the selected type and uses safe download names", () => {
    const job = workspace.jobs[0];
    expect(researchReport(job, "BACKLINK_ANALYSIS")).toEqual(job.result);
    expect(researchReport(job, "DOMAIN_ANALYSIS")).toBeNull();
    expect(researchReport({ ...job, status: "FAILED" }, "BACKLINK_ANALYSIS")).toBeNull();
    expect(researchFilename("../bad:file<script>" )).toBe(".._bad_file_script_.md");
    expect(researchFilename("")).toBe("seo-research.md");
  });
});
describe("research UI accuracy", () => {
  it("keeps both pages on source data by default without mounting account UI or generating", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const Component of [DomainOverviewClient, BacklinksClient]) {
      const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><Component siteId="site" domain="example.com" hasDataForSEO={false} /></I18nProvider>);
      expect(html).toContain("来源数据"); expect(html).toContain("ChatGPT 诊断建议"); expect(html).not.toContain("Connection");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders GSC clicks and observed queries according to the returned source", () => {
    const data = { domain: "example.com", source: "gsc", overview: { organicKeywords: 12, organicTraffic: 30, organicCost: null, backlinks: null, referringDomains: null }, backlinks: null };
    const gsc = renderToStaticMarkup(<I18nProvider initialLocale="en"><DomainCard data={data} label="Own site" /></I18nProvider>);
    expect(gsc).toContain("GSC clicks"); expect(gsc).toContain("GSC observed queries"); expect(gsc).not.toContain("Organic traffic");
    expect(gsc).toContain("not the market&#x27;s total keywords");
    const paid = renderToStaticMarkup(<I18nProvider initialLocale="en"><DomainCard data={{ ...data, source: "dataforseo" }} label="Own site" /></I18nProvider>);
    expect(paid).toContain("Organic traffic"); expect(paid).not.toContain("GSC clicks");
    expect(backlinkSourceLabel("crawl", true)).toContain("出站链接样本，不是反向链接");
    expect(backlinkSourceLabel("dataforseo")).toContain("DataForSEO incoming backlink data");
    expect(backlinkSourceLabel("none")).toContain("unknown");
  });
  it("renders report and evidence as inert text, discloses sample limits and offers explicit export", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><ResearchAiPanel siteId="site" domain="example.com" kind="BACKLINK_ANALYSIS" initialData={workspace} /></I18nProvider>);
    for (const text of ["反链总量与权威评分保持未知", "未核验入站样本", "不含表头", "复制报告", "下载 Markdown", "本次任务使用的已保存证据", "最多显示 12 个页面样本"]) expect(html).toContain(text);
    expect(html).toContain('data-return="backlinks"'); expect(html).toContain('data-account-only="true"');
    expect(html).toContain("&lt;img"); expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain('href="https://news.example.com/a"'); expect(fetch).not.toHaveBeenCalled();
  });
  it("supports English domain analysis and blocks a different active task", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><ResearchAiPanel siteId="site" domain="example.com" kind="DOMAIN_ANALYSIS" initialData={{ ...workspace, jobs: [], activeTask: { id: "other", kind: "WRITE_ARTICLE", title: "Article" } }} /></I18nProvider>);
    expect(html).toContain('data-return="domain-overview"'); expect(html).toContain("This site already has an active task");
    expect(html).toContain("does not filter or change the saved GSC period"); expect(html).not.toContain("Paste backlink samples (optional, TSV)");
    expect(html).toMatch(/type="submit"[^>]+disabled=""/);
  });
});
