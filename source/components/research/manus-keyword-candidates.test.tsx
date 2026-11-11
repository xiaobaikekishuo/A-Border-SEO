import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import type { ManusKeywordCandidate } from "@/lib/manus/keyword-workbook";
import { filterManusCandidates, ManusCandidateTable, selectablePageWords } from "./manus-keyword-candidates";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const rows: ManusKeywordCandidate[] = [
  { keyword: "静态住宅 IP", alternateKeyword: "Static residential IP", cluster: "网络", intent: "对比", priority: "P1",
    rationale: "Compare connection types", metricEvidence: "Estimated range for US", volume: "100–200" },
  { keyword: "城市选择", alternateKeyword: "City-level targeting", cluster: "配置", intent: "指南" },
  { keyword: "本地同义词", alternateKeyword: "STATIC Residential IP", cluster: "配置" },
  { keyword: "其他", cluster: "配置" },
];

describe("completed Manus workbook review", () => {
  it("matches the primary and English keyword, intent and priority together with the selected cluster", () => {
    expect(filterManusCandidates(rows, "  ＣＩＴＹ ", "配置")).toEqual([rows[1]]);
    expect(filterManusCandidates(rows, "静态", "网络")).toEqual([rows[0]]);
    expect(filterManusCandidates(rows, "指南", "网络")).toEqual([]);
    expect(filterManusCandidates(rows, "p1", "")).toEqual([rows[0]]);
  });

  it("selects only visible unsaved words from the chosen column, skipping missing and equivalent English terms", () => {
    expect(selectablePageWords(rows.slice(1), "keyword", new Set(["其他"]))).toEqual(["城市选择", "本地同义词"]);
    expect(selectablePageWords(rows, "alternateKeyword", new Set(["static residential ip"]))).toEqual(["City-level targeting"]);
    expect(selectablePageWords(rows, "alternateKeyword", new Set())).toHaveLength(2);
  });

  it("opens a restored workbook with no words checked, per-site navigation, and workbook evidence in both locales", () => {
    const onSave = vi.fn();
    for (const locale of ["zh", "en"] as const) {
      const html = renderToStaticMarkup(<I18nProvider initialLocale={locale}><ManusCandidateTable siteId="current/site"
        preview={{ rows, filename: "keywords.xlsx", source: "manus", revision: 1, saved: ["静态住宅 ip"] }} disabled={false} onSave={onSave} /></I18nProvider>);
      for (const label of (locale === "zh" ? ["Manus 附件", "勾选本页", "要保存的词列", "已保存", "保存已选关键词（0）", "指标依据"] :
        ["Manus attachment", "Select this page", "Column to save", "Already saved", "Save selected (0)", "Metric evidence"])) expect(html).toContain(label);
      expect(html).toContain("/sites/current%2Fsite/saved-keywords");
      expect(html).toContain("Static residential IP");
      expect(html).toContain("Estimated range for US");
      expect(html).toContain("100–200");
      expect(html).toMatch(/type="checkbox"[^>]+disabled=""/);
      expect(html).not.toMatch(/type="checkbox"[^>]+checked=""/);
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it("paginates large workbooks and hides the English selector for a single-column workbook", () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ keyword: `query number ${i + 1}` }));
    const html = renderToStaticMarkup(<ManusCandidateTable preview={{ rows: many, filename: "local.xlsx", source: "upload", revision: 2, saved: [] }}
      siteId="site" disabled={false} onSave={vi.fn()} />);
    expect(html).toContain("Uploaded workbook");
    expect(html).toContain("1–20 of 22");
    expect(html).toContain("query number 20");
    expect(html).not.toContain("query number 21");
    expect(html).not.toContain("Column to save");
  });
});
