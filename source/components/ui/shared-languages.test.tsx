import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: vi.fn(), push: vi.fn()}), usePathname: () => "/sites/site-a/keywords"}));
vi.mock("@/lib/db", () => ({db: {}}));
import { I18nProvider } from "@/lib/i18n/client";
import { KeywordsTable } from "@/components/sites/keywords-table";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { useUiText } from "./ui-text";
import { intervalLabel } from "@/components/settings/schedule-section";
import { paginate } from "@/components/sites/crawled-pages-table";
import type { Locale } from "@/lib/i18n/shared";

function render(locale: Locale, children: ReactNode) {
 return renderToStaticMarkup(<I18nProvider initialLocale={locale}>{children}</I18nProvider>);
}
function DynamicLabels() {
 const ui = useUiText();
 return <p>{intervalLabel(14, ui)} | {paginate([1,2,3], 3, 0, ui).summary}</p>;
}

describe("shared UI languages", () => {
 it("translates table controls and dynamic sort summaries without translating a keyword", () => {
  const rows = [{query: "Settings", clicks: 12, impressions: 100, position: 4, ctr: .12}];
  const zh=render("zh", <KeywordsTable keywords={rows}/>);
  expect(zh).toContain("最低点击量");
  expect(zh).toContain("显示 1 / 1 个关键词 · 排序：点击量 降序");
  expect(zh).toContain("Settings");
  expect(zh).toContain('value="clicks"');
  expect(zh).toContain('value="all"');
  const en=render("en", <KeywordsTable keywords={rows}/>);
  expect(en).toContain("Min clicks");
  expect(en).toContain("Showing 1 of 1 keywords · sorted by clicks descending");
  expect(en).not.toContain("最低点击量");
 });
 it("translates the site navigation in both locales while retaining route ids", () => {
  const sites=[{id:"site-a", domain:"ssad.shop"}];
  const zh=render("zh",<SidebarNav sites={sites}/>);
  const en=render("en",<SidebarNav sites={sites}/>);
  expect(zh).toContain("内容规划"); expect(en).toContain("Content planning");
  expect(zh).toContain('href="/sites/site-a/content"');
  expect(en).toContain('href="/sites/site-a/content"');
 });
 it("formats count and interval templates in the selected language", () => {
  expect(render("zh", <DynamicLabels/>)).toContain("每 2 周");
  expect(render("zh", <DynamicLabels/>)).toContain("显示 3 条 / 3 页");
  expect(render("en", <DynamicLabels/>)).toContain("Every 2 weeks");
  expect(render("en", <DynamicLabels/>)).toContain("Showing 3 of 3 pages");
 });
});
