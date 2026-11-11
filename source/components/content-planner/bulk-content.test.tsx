import { renderToStaticMarkup as renderRaw } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { createTranslator, type Locale } from "@/lib/i18n/shared";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
function renderToStaticMarkup(node: ReactNode, locale: Locale = "zh") {
  return renderRaw(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
}
import { BulkImport, ImportPreview } from "./bulk-import";
import { BulkUpdateDialog, ManagedArticleTable } from "./bulk-manage";
import { ContentPlanner } from "./content-planner";
import { ConceptGuide } from "./planner-ui";
import { BULK_LIMIT, addLimitedSelection, bulkUpdateData, draftFromPage, importPayload, importSkipReason, type PageInventory } from "./bulk-model";
import type { ClusterRow, Pillar, PlannerData } from "./model";
import { plannerApiError } from "./api-messages";

const pillar: Pillar = { id: "pillar1", title: "Apple ID 使用指南", keyword: "Apple ID", description: "", audience: "", goal: "", url: null, source: "MANUAL", createdAt: "2026-11-04", updatedAt: "2026-11-04", searchVolume: null, performance: null, clusters: [] };
const row: ClusterRow = { id: "cluster1", pillarId: pillar.id, pillarTitle: pillar.title, title: "已有文章标题", keyword: "原关键词", funnel: "MOFU", intent: "比较", contentType: "Article", status: "PUBLISHED", url: "https://ssad.shop/article/existing", scheduledFor: null, brief: null, source: "MANUAL", searchVolume: null, performance: null, createdAt: "2026-11-04", updatedAt: "2026-11-04" };
const inventory: PageInventory = {
  siteId: "site1", crawl: { id: "crawl1", finishedAt: null, pagesFound: 200, maxPages: 200, sampleLimited: true }, total: 3, page: 1, pageSize: 25,
  rows: [
    { id: "page1", title: "文章标题 - 网站名称", url: "https://ssad.shop/article/new", suggestedKeyword: "文章关键词", articleCandidate: true },
    { id: "page2", title: "已导入文章", url: row.url!, suggestedKeyword: "已有词", articleCandidate: true, existingClusterId: row.id, existingPillarTitle: pillar.title },
    { id: "page3", title: "其他网站页面", url: "https://other.example/article", suggestedKeyword: "其他词", articleCandidate: false },
  ],
};
const submit = async () => null;
const noop = () => {};

describe("bounded bulk content operations", () => {
  it("preserves earlier page selections, deduplicates IDs, and never silently exceeds 50", () => {
    const current = Array.from({ length: 49 }, (_, index) => `page${index}`);
    const result = addLimitedSelection(current, ["page0", "new1", "new1", "new2", "new3"]);
    expect(result.ids).toHaveLength(BULK_LIMIT);
    expect(result.ids.slice(0, 49)).toEqual(current);
    expect(result.ids.at(-1)).toBe("new1");
    expect(result.omitted).toBe(2);
    expect(current).toHaveLength(49);
  });
  it("imports manually edited metadata with page IDs, without trusting a client URL or inventing a brief", () => {
    const draft = draftFromPage(inventory.rows[0]);
    expect(draft.funnel).toBe("TOFU");
    expect(draft.title).toBe("文章标题 - 网站名称");
    const payload = importPayload(pillar.id, [{ ...draft, title: "  去掉后缀后的标题  ", keyword: " 手动确认的关键词 ", funnel: "BOFU" }]);
    expect(payload).toEqual({ action: "importPages", pillarId: pillar.id, items: [{ pageId: "page1", title: "去掉后缀后的标题", keyword: "手动确认的关键词", funnel: "BOFU" }] });
    expect(payload.items[0]).not.toHaveProperty("url");
    expect(payload.items[0]).not.toHaveProperty("brief");
  });
  it("does not send unchanged fields when moving or recategorizing selected articles", () => {
    expect(bulkUpdateData({ pillarId: "", funnel: "", status: "" })).toEqual({});
    expect(bulkUpdateData({ pillarId: "pillar2", funnel: "", status: "" })).toEqual({ pillarId: "pillar2" });
    expect(bulkUpdateData({ pillarId: "", funnel: "MOFU", status: "REVIEW" })).toEqual({ funnel: "MOFU", status: "REVIEW" });
  });
  it("explains each skip category with an actionable keyword-conflict message", () => {
    expect(importSkipReason("already_linked")).toContain("已归入");
    expect(importSkipReason("keyword_conflict")).toContain("修改关键词后重试");
    expect(importSkipReason("duplicate_in_request")).toContain("本批次重复");
    expect(importSkipReason("future_reason")).toContain("future_reason");
  });
});

describe("bulk content presentation", () => {
  it("labels the sampled inventory, defaults article filtering on, and prevents already-linked or off-site selection", () => {
    const html = renderToStaticMarkup(<BulkImport siteId="site1" domain="ssad.shop" pillars={[pillar]} busy={false} error={null} onSubmit={submit} onClose={noop} onCreatePillar={noop} onComplete={noop} initialPages={inventory} />);
    expect(html).toContain("日期未记录");
    expect(html).toContain("有限样本，不是全站文章清单");
    expect(html).toMatch(/<input type="checkbox" checked=""\/>仅文章候选/);
    expect(html).toContain("页面规则识别，非 AI");
    expect(html).toContain("已归入：Apple ID 使用指南，不可重复导入");
    for (const title of ["已导入文章", "其他网站页面"]) {
      const checkbox = html.match(new RegExp(`<input[^>]*aria-label="选择已有页面：${title}"[^>]*>`))?.[0];
      expect(checkbox).toContain('disabled=""');
    }
    expect(html).not.toContain('href="https://other.example/article"');
  });
  it("guides sites without pillars to create one instead of inserting examples", () => {
    const html = renderToStaticMarkup(<BulkImport siteId="site1" domain="ssad.shop" pillars={[]} busy={false} error={null} onSubmit={submit} onClose={noop} onCreatePillar={noop} onComplete={noop} initialPages={inventory} />);
    expect(html).toContain("先新建主题");
    expect(html).toContain("不会自动创建演示数据");
  });
  it("keeps the imported HTML title editable and makes the published/manual/no-remote-change behavior explicit", () => {
    const html = renderToStaticMarkup(<ImportPreview drafts={[draftFromPage(inventory.rows[0])]} pillars={[pillar]} pillarId={pillar.id} onPillar={noop} batchFunnel="TOFU" onBatchFunnel={noop} onEdit={noop} onRemove={noop} onBack={noop} onSubmit={noop} busy={false} domain="ssad.shop" />);
    expect(html).toContain('aria-label="文章 1 标题"');
    expect(html).toContain('value="文章标题 - 网站名称"');
    expect(html).toContain('aria-label="文章 1 关键词"');
    expect(html).toContain("这是人工整理已有文章，不使用 AI 自动归类");
    expect(html).toContain("默认“已发布”，不生成简报、不修改远程正文");
  });
  it("keeps the selected article review and unchanged defaults visible after a batch conflict", () => {
    const html = renderToStaticMarkup(<BulkUpdateDialog selectedRows={[row]} pillars={[pillar]} busy={false} error="目标主题存在相同关键词" onClose={noop} onSubmit={submit} onSuccess={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("勾选和设置仍保留");
    expect(html).toContain("冲突时整批不更新");
    expect(html).toContain("已有文章标题");
    expect(html).toContain("不变 · 保留各自主题");
    expect(html).toContain("不变 · 保留各自阶段");
    expect(html).toContain("不变 · 保留各自状态");
    expect(html).toContain("标题、关键词、URL、排期和简报保持不变");
  });
  it("provides accessible article selection and renders a usable empty-filter state", () => {
    const props = { allRows: [row], pillars: [pillar], domain: "ssad.shop", busy: false, error: null, onBrief: noop, onEdit: noop, onDelete: noop, onStatus: async () => {}, onSubmit: submit, onClearError: noop, onUpdated: noop };
    const html = renderToStaticMarkup(<ManagedArticleTable {...props} rows={[row]} />);
    expect(html).toContain('aria-label="勾选文章：已有文章标题"');
    expect(html).toContain('aria-label="勾选当前筛选结果，最多 50 条"');
    const empty = renderToStaticMarkup(<ManagedArticleTable {...props} rows={[]} />);
    expect(empty).toContain("文章批量操作");
    expect(empty).toContain("之前勾选的文章仍然保留");
  });
  it("exposes the import entry even before a pillar exists and explains the existing-article workflow", () => {
    const data: PlannerData = { site: { id: "site1", domain: "ssad.shop" }, pillars: [], jobs: [], worker: { online: false, lastSeenAt: null }, metricsPeriod: null };
    expect(renderToStaticMarkup(<ContentPlanner siteId="site1" domain="ssad.shop" initialData={data} />)).toContain("导入已有文章");
    const guide = renderToStaticMarkup(<ConceptGuide />);
    expect(guide).toContain("网站已经有文章？三步整理进来");
    expect(guide).toContain("补充用于改稿的内容简报");
    expect(guide).toContain("本地规划修改不等于网站内容更新");
  });
});

describe("English bulk content presentation", () => {
  it("localizes import controls and previews without changing stored article titles", () => {
    const html = renderToStaticMarkup(<BulkImport siteId="site1" domain="ssad.shop" pillars={[pillar]} busy={false} error={null} onSubmit={submit} onClose={noop} onCreatePillar={noop} onComplete={noop} initialPages={inventory} />, "en");
    expect(html).toContain("Import existing articles");
    expect(html).toContain("limited sample");
    expect(html).toContain("Article candidates only");
    expect(html).toContain("文章标题 - 网站名称");
    expect(html).toContain('aria-label="Select existing page: 文章标题 - 网站名称"');
    expect(html).not.toContain("仅文章候选");
    const props = { allRows: [row], pillars: [pillar], domain: "ssad.shop", busy: false, error: null, onBrief: noop, onEdit: noop, onDelete: noop, onStatus: async () => {}, onSubmit: submit, onClearError: noop, onUpdated: noop };
    const table = renderToStaticMarkup(<ManagedArticleTable {...props} rows={[row]} />, "en");
    expect(table).toContain("Actual GSC data");
    expect(table).toContain("Published");
    expect(table).toContain("已有文章标题");
    expect(table).toContain('aria-label="Select article: 已有文章标题"');
    expect(table).not.toContain("未核验内链");
  });
  it("translates only known application errors, retaining unknown server text verbatim", () => {
    const en = createTranslator("en"), zh = createTranslator("zh");
    expect(importSkipReason("keyword_conflict", en)).toContain("Edit the keyword");
    expect(plannerApiError("Pillar not found", zh)).toContain("未找到总览主题");
    expect(plannerApiError("Pillar not found", en)).toBe("Pillar not found");
    expect(plannerApiError("用户原文 {v0}", en)).toBe("用户原文 {v0}");
  });
});
