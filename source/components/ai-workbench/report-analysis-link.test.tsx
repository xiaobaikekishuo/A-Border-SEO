import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionScopes } from "@/lib/ai-workbench/action-scope";
import { createTranslator } from "@/lib/i18n/shared";
import { ReportAnalysisLink } from "./report-analysis-link";

describe("report handoff to the workbench", () => {
  it.each(actionScopes)("links to the same site’s %s preview without prefetching or submitting a job", scope => {
    for (const locale of ["en", "zh"] as const) {
      const link = ReportAnalysisLink({ siteId: "site/special ?", scope, t: createTranslator(locale) });
      expect(link.props.prefetch).toBe(false);
      const html = renderToStaticMarkup(link);
      expect(html).toContain(`href="/sites/site%2Fspecial%20%3F/assistant?actionScope=${scope}"`);
      expect(html).toContain(locale === "zh" ? "预览已保存的数据" : "Preview saved data");
      expect(html).toContain(scope === "weekly"
        ? (locale === "zh" ? "生成本周行动清单" : "Generate this week’s action list")
        : "ChatGPT");
    }
  });
});
