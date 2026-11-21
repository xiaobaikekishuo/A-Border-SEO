import { describe, expect, it } from "vitest";
import { workbenchRequestSchema, type WorkbenchResult } from "../schema";
import { buildHreflangPlan, hreflangCode, localizePrompt, reviewLocalization, TARGET_URL_PLACEHOLDER, type LocalizeContext } from "./localize";

const base: WorkbenchResult = { title: "t", summary: "s", contentMarkdown: "Lokalisierter Text", metaTitle: "Titel", metaDescription: "Beschreibung", changeNotes: [], factChecks: ["prüfen"], internalLinks: [], paragraphEdits: [] };

describe("hreflang codes", () => {
  it("combines the language base and the country", () => {
    expect(hreflangCode("de", 2276)).toBe("de-DE");
    expect(hreflangCode("zh-TW", 2344)).toBe("zh-HK");
    expect(hreflangCode("en", 2826)).toBe("en-GB");
    expect(hreflangCode("en", 1)).toBeNull();
  });
});

describe("hreflang plan", () => {
  it("adds the source page, the new version and x-default when the page has no alternates", () => {
    const plan = buildHreflangPlan({ sourceUrl: "https://shop.test/guide", existing: [], sourceGuess: "en-US", code: "de-DE", targetUrl: "https://shop.test/de/guide" });
    expect(plan.tags).toEqual([
      { hreflang: "en-US", href: "https://shop.test/guide" },
      { hreflang: "de-DE", href: "https://shop.test/de/guide" },
      { hreflang: "x-default", href: "https://shop.test/guide" },
    ]);
    expect(plan.sourceCode).toBe("en-US");
    expect(plan.sourceCodeGuessed).toBe(true);
    expect(plan.notes).toEqual(expect.arrayContaining(["SAME_TAGS_ON_EVERY_VERSION", "SOURCE_CODE_GUESSED", "X_DEFAULT_SOURCE"]));
    expect(plan.html.split("\n")[1]).toBe('<link rel="alternate" hreflang="de-DE" href="https://shop.test/de/guide" />');
  });
  it("keeps valid existing alternates, replaces the target market's and leaves a placeholder without an address", () => {
    const plan = buildHreflangPlan({ sourceUrl: "https://shop.test/guide/", sourceGuess: "en-US", code: "fr-FR", targetUrl: null, existing: [
      { lang: "en", href: "https://shop.test/guide" }, { lang: "fr-FR", href: "https://shop.test/fr/old" },
      { lang: "x-default", href: "https://shop.test/" }, { lang: "en_GB", href: "https://shop.test/uk" },
    ] });
    expect(plan.sourceCode).toBe("en");
    expect(plan.sourceCodeGuessed).toBe(false);
    expect(plan.tags).toEqual([
      { hreflang: "en", href: "https://shop.test/guide" },
      { hreflang: "fr-FR", href: TARGET_URL_PLACEHOLDER },
      { hreflang: "x-default", href: "https://shop.test/" },
    ]);
    expect(plan.notes).toEqual(expect.arrayContaining(["REPLACED_EXISTING", "TARGET_URL_PLACEHOLDER", "INVALID_EXISTING_SKIPPED"]));
    expect(plan.notes).not.toContain("X_DEFAULT_SOURCE");
  });
  it("escapes addresses in the tags", () => {
    const plan = buildHreflangPlan({ sourceUrl: "https://shop.test/a?x=1&y=2", existing: [], sourceGuess: null, code: "ja-JP", targetUrl: "https://shop.test/ja?x=1&y=\"2\"" });
    expect(plan.html).toContain('href="https://shop.test/a?x=1&amp;y=2"');
    expect(plan.html).not.toContain('"2"');
  });
});

describe("localization results", () => {
  const context = { hreflang: buildHreflangPlan({ sourceUrl: "https://shop.test/guide", existing: [], sourceGuess: "en-US", code: "de-DE", targetUrl: null }) } as LocalizeContext;
  it("attaches the program's tags and deduplicates local keywords", () => {
    const checked = reviewLocalization({ ...base, localKeywords: [
      { keyword: "Handyhülle", intent: "COMMERCIAL", use: "title", note: "n" },
      { keyword: "handyhülle ", intent: "COMMERCIAL", use: "heading", note: "n" },
      { keyword: "Hülle iPhone 16", intent: "TRANSACTIONAL", use: "body", note: "n" },
    ], hreflang: { ...context.hreflang!, html: "<script>model</script>" } }, context);
    expect(checked.localKeywords!.map(k => k.keyword)).toEqual(["Handyhülle", "Hülle iPhone 16"]);
    expect(checked.hreflang).toEqual(context.hreflang);
  });
  it("has no tags for pasted text", () => {
    expect(reviewLocalization({ ...base, localKeywords: [] }, { hreflang: null }).hreflang).toBeUndefined();
  });
  it("never sends the program's tags to Codex", () => {
    const input = workbenchRequestSchema.parse({ kind: "LOCALIZE_ARTICLE", title: "Guide", language: "de", body: "x".repeat(120), localization: { location: 2276 } });
    const prompt = localizePrompt(input, { domain: "shop.test", body: "Body", bodySource: "PASTED", page: null, knownPages: [], allowedInternalLinks: [], trustedSources: [],
      target: { language: "de", languageName: "German", country: "Germany", countryIso: "DE", hreflang: "de-DE" }, hreflang: context.hreflang });
    expect(prompt).toContain("German speakers in Germany");
    expect(prompt).not.toContain("x-default");
  });
});
