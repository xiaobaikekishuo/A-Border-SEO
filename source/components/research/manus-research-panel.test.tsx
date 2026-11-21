import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/sites/site-a/geo" }));
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/shared";
import type { ResearchTaskList } from "@/lib/manus/research";
import type { ManusTemplate } from "@/lib/manus/templates";
import { ManusResearchPanel } from "./manus-research-panel";

const options = {
  site: "kammakhome.com", market: "United States, English", brand: "Kammak", competitors: ["Acme"],
  gaps: [{ domain: "reddit.com", type: "FORUM", gapAnswers: 3, answers: 4, competitors: ["Acme"] }],
  competitorDomains: ["acme.test"],
};
const geoTask = {
  id: "t1", kind: "GEO_SOURCES" as const, requestId: "r1", status: "completed" as const, taskUrl: "https://manus.im/app/t1",
  summary: "Reddit first.", extracted: true, errorCode: null, refreshable: true, createdAt: "2026-11-19T08:00:00.000Z", updatedAt: "2026-11-19T08:30:00.000Z",
  input: { site: "kammakhome.com", brand: "Kammak", competitors: ["Acme"], market: "United States, English", language: "English", profile: "lite" as const, sources: [{ domain: "reddit.com", type: "FORUM", competitors: ["Acme"], prompts: [], urls: [] }] },
  rows: [{
    domain: "reddit.com", pageType: "forum_or_qa", maintainer: "Community moderators", howToGetIncluded: "Answer in relevant threads and disclose the relationship", requirements: null,
    contactUrl: "https://www.reddit.com/r/sofas/about", effort: "low" as const, priority: "high" as const, why: "Cited in 3 answers", evidenceUrls: ["https://reddit.com/r/sofas/1"], observedOn: "2026-11-19",
  }],
};

function render(locale: Locale, kind: ManusTemplate, initial: ResearchTaskList) {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}><ManusResearchPanel siteId="site-a" kind={kind} initial={initial} /></I18nProvider>);
}

describe("Manus research panel", () => {
  it("offers the citation gaps and shows a finished task as a table", () => {
    const html = render("en", "GEO_SOURCES", { connected: true, nextCursor: null, options, tasks: [geoTask] });
    expect(html).toContain("Break down AI citation sources with Manus");
    expect(html).toMatch(/type="checkbox"[^>]*checked=""[\s\S]*?reddit\.com/);
    expect(html).toContain("3 of 4 answers left you out");
    expect(html).toContain("Answer in relevant threads and disclose the relationship");
    expect(html).toContain('href="https://www.reddit.com/r/sofas/about"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("Download CSV");
  });

  it("asks for prompt tracking first, and fills the link form from it, in Chinese", () => {
    const empty = { connected: false, nextCursor: null, tasks: [], options: { ...options, brand: null, gaps: [] } };
    expect(render("zh", "GEO_SOURCES", empty)).toContain("请先在上方设置提示词跟踪并运行一次");
    const link = render("zh", "LINK_PROSPECTS", { connected: true, nextCursor: null, tasks: [], options });
    expect(link).toContain("让 Manus 调研外链机会");
    expect(link).toContain(">acme.test</textarea>");
    expect(link).toContain('value="United States, English"');
    expect(link).toContain("暂无任务。");
    expect(link).not.toMatch(/[\u2014\u2015]/);
  });
});
