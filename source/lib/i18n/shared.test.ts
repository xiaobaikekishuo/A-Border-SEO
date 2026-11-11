import { describe, expect, it } from "vitest";
import { createTranslator, htmlLanguage, localeCookie, normalizeLocale } from "./shared";

describe("interface locale", () => {
  it("defaults missing or unsupported preferences to Chinese", () => {
    for (const value of [undefined, null, "", "fr", "EN", "en; Path=/x"]) expect(normalizeLocale(value)).toBe("zh");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("zh")).toBe("zh");
  });
  it("translates interface templates without translating or expanding user data", () => {
    const title = "我的文章 {count} / Apple ID";
    expect(createTranslator("en")("Edit {title}", "编辑 {title}", { title, count: 3 })).toBe(`Edit ${title}`);
    expect(createTranslator("zh")("{count} pages", "{count} 个页面", { count: 0 })).toBe("0 个页面");
    expect(createTranslator("en")("{unknown}", "{unknown}", {})).toBe("{unknown}");
  });
  it("persists the preference across routes for one year without domain scope", () => {
    expect(localeCookie("en")).toBe("aborder-locale=en; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(localeCookie("zh", true)).toContain("; Secure");
    expect(htmlLanguage("zh")).toBe("zh-CN");
    expect(htmlLanguage("en")).toBe("en");
  });
});
