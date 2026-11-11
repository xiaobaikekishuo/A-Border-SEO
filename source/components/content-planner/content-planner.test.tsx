import { renderToStaticMarkup as renderRaw } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { createTranslator, type Locale } from "@/lib/i18n/shared";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
function renderToStaticMarkup(node: ReactNode, locale: Locale = "zh") {
  return renderRaw(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
}
import { ContentPlanner, PlanPanel, ProposalReview } from "./content-planner";
import { ClusterForm } from "./planner-forms";
import { ConceptGuide } from "./planner-ui";
import { applyPlanMessage, briefMarkdown, clusterRows, filterClusters, formatCount, jobLabel, linkEvidenceLabel, planErrorMessage, plannerStats, proposalSelectionCounts, safeSiteUrl, type Brief, type Cluster, type Pillar, type PlanJob, type PlannerData } from "./model";

const period = { startDate: "2026-10-07", endDate: "2026-11-01" };
const metrics = { clicks: 3, impressions: 21, ctr: 3 / 21, position: 8.2, period };
const brief: Brief = {
  summary: "解释账号用途差异", audience: "新手用户", searchIntent: "了解区别", angle: "从登录位置和数据用途区分",
  outline: ["各自的用途", "常见误解"], keyPoints: ["核实官方说明"], cta: "阅读地区指南",
  internalLinks: [{ title: "地区指南", target: "/article/region-guide", reason: "延伸了解地区差异" }],
  evidenceNotes: ["需按官方文档核实，不保证排名提升。"],
};
function cluster(overrides: Partial<Cluster> = {}): Cluster {
  return { id: "c1", pillarId: "p1", title: "App Store 与 iCloud 区别", keyword: "iCloud 区别", funnel: "TOFU", intent: "了解", contentType: "指南", status: "BRIEF_READY", url: "https://ssad.shop/article/region-guide", scheduledFor: null, brief, source: "EXAMPLE", searchVolume: null, performance: metrics, createdAt: "2026-11-04", updatedAt: "2026-11-04", ...overrides };
}
function pillar(overrides: Partial<Pillar> = {}): Pillar {
  return { id: "p1", title: "Apple ID 地区与使用指南", keyword: "Apple ID 地区", description: "梳理地区差异与账号用途。", audience: "新手用户", goal: "正确认识账号用途", url: "https://ssad.shop/article/region-guide", source: "EXAMPLE", createdAt: "2026-11-04", updatedAt: "2026-11-04", searchVolume: null, performance: metrics, clusters: [cluster()], ...overrides };
}
function workspace(domain = "ssad.shop", pillars: Pillar[] = []): PlannerData {
  return { site: { id: "s1", domain }, pillars, jobs: [], worker: { online: false, lastSeenAt: null }, metricsPeriod: null };
}

describe("content planner data presentation", () => {
  it("skips normalized duplicate keywords unless brief updates are explicitly selected", () => {
    const topics = [{ keyword: " Ａｐｐｌｅ　ＩＤ " }, { keyword: "新主题" }];
    const existing = [{ keyword: "apple  id" }];
    expect(proposalSelectionCounts(topics, existing, [0, 1, 1], false)).toEqual({ existingIndexes: [0], added: 1, updated: 0, skipped: 1 });
    expect(proposalSelectionCounts(topics, existing, [0, 1], true)).toEqual({ existingIndexes: [0], added: 1, updated: 1, skipped: 0 });
    expect(proposalSelectionCounts(topics, existing, [1], true)).toMatchObject({ added: 1, updated: 0, skipped: 0 });
    expect(applyPlanMessage({ imported: 1, updated: 2, alreadyApplied: false }, 4)).toBe("已采纳：新增 1 个选题，更新 2 份简报，跳过重复 1 个。");
    expect(applyPlanMessage({ imported: 0, updated: 0, alreadyApplied: true }, 3)).toBe("这份规划已采纳，未重复新增或更新。");
  });
  it("deduplicates mapped URLs and never counts a linked example as published", () => {
    expect(plannerStats([pillar()])).toMatchObject({ pillars: 1, clusters: 1, published: 0, coverage: 0, mapped: 1, clicks: 3, impressions: 21 });
    expect(plannerStats([pillar({ performance: null, clusters: [cluster({ performance: null })] })])).toMatchObject({ clicks: null, impressions: null, mapped: 0 });
    expect(formatCount(null)).toBe("暂无数据");
    expect(formatCount(0)).toBe("0");
  });
  it("combines topic, funnel, status and text filters without mixing pillars", () => {
    const rows = clusterRows([pillar({ clusters: [cluster(), cluster({ id: "c2", title: "地区选择比较", keyword: "地区比较", funnel: "MOFU", status: "WRITING" })] }), pillar({ id: "p2", title: "其他主题", clusters: [cluster({ id: "c3", pillarId: "p2", funnel: "MOFU", status: "WRITING", title: "地区选择比较" })] })]);
    expect(filterClusters(rows, { query: " 地区 ", pillar: "p1", funnel: "MOFU", status: "WRITING" }).map(row => row.id)).toEqual(["c2"]);
  });
  it("exports the actual brief with evidence and keeps it distinct from a finished article", () => {
    const markdown = briefMarkdown("账号用途区别", "账号用途", brief);
    expect(markdown).toContain("## 建议大纲\n- 各自的用途\n- 常见误解");
    expect(markdown).toContain("需按官方文档核实");
    expect(markdown).toContain("/article/region-guide");
    expect(markdown).toContain("不是已完成或已发布的文章");
  });
  it("does not turn arbitrary model-provided URLs into unsafe or cross-site links", () => {
    expect(safeSiteUrl("/article/guide", "ssad.shop")).toBe("https://ssad.shop/article/guide");
    for (const value of ["javascript:alert(1)", "https://other.example/article", "https://user:password@ssad.shop/article", "http://ssad.shop/article"]) expect(safeSiteUrl(value, "ssad.shop")).toBeNull();
  });
  it("explains worker failures without suggesting an API fallback", () => {
    expect(planErrorMessage("chatgpt_usage_limit")).toContain("未切换 API");
    expect(planErrorMessage("chatgpt_login_required")).toContain("登录ChatGPT.cmd");
    expect(planErrorMessage("invalid_model_output")).toContain("未采纳任何选题");
    expect(jobLabel({ status: "UNKNOWN", appliedAt: null } as PlanJob)).toBe("未知状态：UNKNOWN");
    expect(linkEvidenceLabel(null)).toBe("未核验内链");
    expect(linkEvidenceLabel({ crawlAt: "2026-11-04", sampleLimited: true, sourceInSample: false, targetInSample: true, pillarToCluster: false, clusterToPillar: false })).toBe("样本未覆盖两页");
  });
});

describe("Chinese planner views", () => {
  it("lets an existing successful proposal open new-plan settings without applying or generating on render", () => {
    const job: PlanJob = { id: "saved-plan", pillarId: "p1", status: "SUCCEEDED", error: null, appliedAt: null, topicCount: 3, funnelCounts: { TOFU: 1, MOFU: 1, BOFU: 1 }, createdAt: "2026-11-04", startedAt: "2026-11-04", finishedAt: "2026-11-04", result: { pillarSummary: "保留这份方案", topics: [{ title: "账号区别", keyword: "ICLOUD 区别", funnel: "TOFU", intent: "了解", contentType: "指南", brief }] } };
    const onStart = vi.fn(async () => {}); const onApply = vi.fn(async () => {});
    const props = { job, pillar: pillar(), workerOnline: true, domain: "ssad.shop", busy: false, otherJob: false, onStart, onApply, onRefresh: () => {} };
    const html = renderToStaticMarkup(<PlanPanel {...props} />);
    expect(html).toContain("调整分配并新建规划");
    expect(html).toContain("仅打开设置，保留当前方案。");
    expect(html).toContain("保留这份方案");
    expect(html).not.toContain("选题数量与读者阶段分配");
    expect(onStart).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    const blocked = renderToStaticMarkup(<PlanPanel {...props} otherJob />);
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?调整分配并新建规划/);
    const english = renderToStaticMarkup(<PlanPanel {...props} />, "en");
    expect(english).toContain("Adjust mix and create a new plan");
    expect(english).toContain("Opens settings only; keeps this proposal.");
    expect(job.appliedAt).toBeNull();
  });

  it("labels existing topics, defaults brief replacement off, and prevents consuming an all-duplicate no-op", () => {
    const job: PlanJob = { id: "job1", pillarId: "p1", status: "SUCCEEDED", error: null, appliedAt: null, createdAt: "2026-11-04", startedAt: "2026-11-04", finishedAt: "2026-11-04", result: { pillarSummary: "规划说明", topics: [{ title: "账号区别", keyword: "ICLOUD 区别", funnel: "TOFU", intent: "了解", contentType: "指南", brief }] } };
    const html = renderToStaticMarkup(<ProposalReview job={job} existingClusters={[cluster()]} domain="ssad.shop" busy={false} onApply={async () => {}} />);
    expect(html).toContain("已有选题");
    expect(html).toContain("保留标题、URL、排期和进度");
    expect(html).toContain("新增 0 个选题，更新 0 份简报，跳过重复 1 个");
    expect(html).toContain("所选选题均已存在");
    expect(html).toContain("确认采纳 1 个选题");
    expect(html).toContain('disabled=""');
    const optIn = html.match(/<input\b[^>]*>同时更新已有选题的简报/);
    expect(optIn).not.toBeNull();
    expect(optIn![0]).not.toContain('checked=""');
  });
  it("offers the labelled example only for ssad.shop and keeps missing traffic unknown", () => {
    const ssad = renderToStaticMarkup(<ContentPlanner siteId="s1" domain="ssad.shop" initialData={workspace()} />);
    expect(ssad).toContain("用 Apple ID 示例学习");
    expect(ssad).toContain("不表示真实 AI 结果、流量或发布状态");
    expect(ssad).toContain("暂无数据");
    expect(ssad).not.toContain("搜/月");
    const other = renderToStaticMarkup(<ContentPlanner siteId="s1" domain="other.example" initialData={workspace("other.example")} />);
    expect(other).not.toContain("用 Apple ID 示例学习");
    expect(other).toContain("other.example");
  });
  it("renders the working views and actual pillar metadata without inventing performance", () => {
    const html = renderToStaticMarkup(<ContentPlanner siteId="s1" domain="ssad.shop" initialData={{ ...workspace("ssad.shop", [pillar()]), metricsPeriod: period }} />);
    for (const label of ["主题支柱", "文章规划", "生产看板", "主题图谱", "新手指南", "AI 规划", "演示示例", "2026-10-07", "2026-11-01"]) expect(html).toContain(label);
    expect(html).toContain('aria-label="编辑主题：Apple ID 地区与使用指南"');
    expect(html).toContain("站点独立规划");
  });
  it("uses the selected map branch as the initial funnel for a new cluster", () => {
    const html = renderToStaticMarkup(<ClusterForm pillars={[pillar()]} initialPillarId="p1" initialFunnel="BOFU" domain="ssad.shop" busy={false} onSave={async () => {}} onCancel={() => {}} />);
    expect(html).toMatch(/<option value="BOFU" selected="">/);
    expect(html).toContain("手动补充内容简报");
  });
  it("explains topic structure separately from decision stages", () => {
    const html = renderToStaticMarkup(<ConceptGuide />);
    for (const text of ["Pillar · 总览主题页", "Cluster · 具体问题内容", "认识问题", "比较方案", "做出决策", "漏斗不是排名等级", "读者可以跨阶段阅读", "标签本身不会保证排名提升"]) expect(html).toContain(text);
  });
});

describe("English planner views", () => {
  it("translates navigation and metrics while preserving saved Chinese topics", () => {
    const html = renderToStaticMarkup(<ContentPlanner siteId="s1" domain="ssad.shop" initialData={workspace("ssad.shop", [pillar()])} />, "en");
    for (const label of ["Content planner", "Production board", "Getting started", "Import existing articles", "Content progress", "Demo example"]) expect(html).toContain(label);
    expect(html).toContain("Apple ID 地区与使用指南");
    expect(html).toContain('aria-label="Edit pillar: Apple ID 地区与使用指南"');
    expect(html).not.toContain("总览主题 · Pillars");
    const guide = renderToStaticMarkup(<ConceptGuide />, "en");
    for (const label of ["Pillar · Overview page", "Cluster · Focused content", "Awareness", "Consideration", "Decision"]) expect(guide).toContain(label);
    expect(guide).not.toContain("漏斗不是排名等级");
  });
  it("localizes brief export labels and status messages without translating the actual brief", () => {
    const t = createTranslator("en");
    const markdown = briefMarkdown("账号用途区别 {v2}", "账号用途", brief, t);
    expect(markdown).toContain("# 账号用途区别 {v2}");
    expect(markdown).toContain("## Suggested outline\n- 各自的用途\n- 常见误解");
    expect(markdown).toContain("not a completed or published article");
    expect(formatCount(null, t)).toBe("No data");
    expect(jobLabel({ status: "SUCCEEDED", appliedAt: null } as PlanJob, t)).toBe("Ready for review");
    expect(planErrorMessage("chatgpt_usage_limit", t)).toContain("No API fallback");
    expect(linkEvidenceLabel(null, t)).toBe("Internal links not checked");
  });
});
