import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { I18nProvider } from "@/lib/i18n/client";
import { TaskEvidence } from "./evidence-panel";
import { ParagraphReview } from "./paragraph-review";
import type { ParagraphEdit, TaskDiagnosticEvidence } from "./model";

const evidence = {
  siteId: "fixture-site", selection: { url: "https://example.test/article" },
  page: null, crawl: null, issues: [], schemaReport: null,
  searchEvidence: { period: { start: "2026-10-01", end: "2026-10-28" }, pagesComplete: false, queryPagesComplete: false, pages: [] },
  queryEvidence: { query: "示例查询", status: "UNKNOWN", clicks: null, impressions: null, ctr: null, position: null },
} as TaskDiagnosticEvidence;
const edit: ParagraphEdit = {
  id: "clarify", sourceText: "这是一段需要澄清含义的原文。", replacementText: "这是解释清楚后的建议段落。",
  reason: "澄清用途", evidence: ["依据提交时的正文"], verification: ["发布前核对事实"],
};

describe("evidence and paragraph presentation", () => {
  it("keeps historical schema and unreported query metrics unknown", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><TaskEvidence evidence={evidence} /></I18nProvider>);
    expect(html).toContain("尚未检查");
    expect(html).toContain("缺失不代表零");
    expect(html).toContain("未知");
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("捕获的 HTML 未发现 JSON-LD");
  });

  it("renders captured schema strings as inert text and identifies partial scope", () => {
    const report: TaskDiagnosticEvidence = { ...evidence, schemaReport: {
      version: 1, coverage: "PARTIAL", truncated: true, jsonLdBlocks: 1, parsedBlocks: 0,
      otherMarkup: false, entities: [], limitations: ["Captured HTML only"],
      findings: [{ code: "JSON_INVALID", path: "script[0]", severity: "ERROR", observed: '<script>alert("example")</script>', expected: "Fix JSON syntax" }],
    } };
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><TaskEvidence evidence={report} /></I18nProvider>);
    expect(html).toContain("JSON-LD 语法不合法");
    expect(html).toContain("部分");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("shows both passages and prevents applying the same accepted edit again", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><ParagraphReview edits={[edit]} text={edit.replacementText} disabled={false} onApply={() => { throw new Error("render must not apply"); }} /></I18nProvider>);
    expect(html).toContain("Original passage");
    expect(html).toContain("Proposed passage");
    expect(html).toContain(edit.sourceText);
    expect(html).toContain(edit.replacementText);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Already present or unchanged");
  });
});
