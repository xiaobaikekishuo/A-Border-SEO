import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { I18nProvider } from "@/lib/i18n/client";
import { LanguageSwitcher } from "./language-switcher";

describe("language selector", () => {
  it("exposes both languages and the active language accessibly", () => {
    const chinese = renderToStaticMarkup(<I18nProvider initialLocale="zh"><LanguageSwitcher /></I18nProvider>);
    expect(chinese).toContain('aria-label="界面语言"');
    expect(chinese).toMatch(/lang="zh-CN" aria-pressed="true"/);
    expect(chinese).toContain("English");
    const english = renderToStaticMarkup(<I18nProvider initialLocale="en"><LanguageSwitcher /></I18nProvider>);
    expect(english).toContain('aria-label="Interface language"');
    expect(english).toMatch(/lang="en" aria-pressed="true"/);
    expect(english).toContain("中文");
  });
  it("remains available when the sidebar is collapsed", () => {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="zh"><LanguageSwitcher compact /></I18nProvider>);
    expect(html).toContain(">EN</button>");
    expect(html).toContain(">中文</button>");
  });
});
