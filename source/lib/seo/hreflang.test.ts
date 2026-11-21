import { describe, expect, it } from "vitest";
import { checkHreflangCode, hreflangIssues, type HreflangPage } from "./hreflang";

describe("hreflang values", () => {
  it("accepts ISO 639-1 languages with optional script and region, and x-default", () => {
    for (const code of ["en", "en-GB", "EN-gb", "zh-Hant", "zh-Hant-TW", "zh-CN", "pt-BR", "x-default", "X-Default"]) {
      expect(checkHreflangCode(code), code).toEqual({ ok: true });
    }
  });

  it("rejects underscores, region-only values, withdrawn and unknown codes", () => {
    expect(checkHreflangCode("en_US")).toEqual({ ok: false, kind: "invalid_code", hint: "en-US" });
    expect(checkHreflangCode("us")).toEqual({ ok: false, kind: "invalid_code", hint: null, regionOnly: true });
    expect(checkHreflangCode("iw")).toEqual({ ok: false, kind: "invalid_code", hint: "he" });
    expect(checkHreflangCode("english")).toMatchObject({ ok: false, kind: "invalid_code" });
    expect(checkHreflangCode("en-XX")).toMatchObject({ ok: false, kind: "invalid_code" });
    expect(checkHreflangCode("en-US-x-test")).toMatchObject({ ok: false, kind: "invalid_code" });
    expect(checkHreflangCode("en-")).toMatchObject({ ok: false, kind: "invalid_code" });
  });

  it("flags region codes Google does not support", () => {
    expect(checkHreflangCode("en-UK")).toEqual({ ok: false, kind: "unsupported_region", hint: "en-GB" });
    expect(checkHreflangCode("es-419")).toEqual({ ok: false, kind: "unsupported_region", hint: null });
    expect(checkHreflangCode("en-EU")).toEqual({ ok: false, kind: "unsupported_region", hint: null });
  });
});

const page = (url: string, tags: [string, string][], over: Partial<HreflangPage> = {}): HreflangPage =>
  ({ url, statusCode: 200, indexable: true, canonical: null, hreflangTags: tags.map(([lang, href]) => ({ lang, href })), ...over });

describe("hreflang sets", () => {
  const en = "https://shop.example/en";
  const de = "https://shop.example/de";

  it("passes a complete, reciprocal set", () => {
    const set: [string, string][] = [["en", en], ["de", de], ["x-default", en]];
    expect(hreflangIssues([page(en, set), page(de, set)])).toEqual([]);
  });

  it("finds missing return links, self references and x-default", () => {
    const issues = hreflangIssues([
      page(en, [["en", en], ["de", de]]),
      page(de, [["de", de]]),
    ], { howToFix: "fix" });
    expect(issues.map(i => [i.url, i.severity, i.message])).toEqual([
      [en, "WARNING", "No return hreflang link from https://shop.example/de (+1 more)"],
    ]);
    expect(issues[0].details).toMatchObject({ kind: "no_return", problems: [{ kind: "no_return" }, { kind: "missing_x_default" }], howToFix: "fix" });
  });

  it("checks codes, absolute URLs, conflicts and listed pages that redirect, break or are noindex", () => {
    const issues = hreflangIssues([
      page(en, [["en", en], ["en_US", "/us"], ["de", de], ["de", "https://shop.example/de-2"], ["fr", "https://shop.example/fr"], ["es", "https://shop.example/es"]]),
      page(de, [["de", de], ["en", en]], { indexable: false }),
      page("https://shop.example/es", [], { statusCode: 404 }),
    ], { redirects: new Map([["https://shop.example/fr", "https://shop.example/fr-fr"]]) });
    expect(issues).toHaveLength(1);
    const kinds = (issues[0].details.problems as { kind: string; reason?: string }[]).map(p => p.reason ? `${p.kind}:${p.reason}` : p.kind);
    expect(kinds).toEqual(["invalid_code", "relative_url", "conflict", "bad_alternate:noindex", "bad_alternate:redirect", "bad_alternate:broken", "missing_x_default"]);
    expect(issues[0].message).toBe('Invalid hreflang value "en_US" (+6 more)');
  });

  it("reports a missing x-default alone as information", () => {
    const set: [string, string][] = [["en", en], ["de", de]];
    const issues = hreflangIssues([page(en, set), page(de, set)]);
    expect(issues.map(i => [i.severity, i.message])).toEqual([
      ["INFO", "hreflang set has no x-default"], ["INFO", "hreflang set has no x-default"],
    ]);
  });

  it("skips pages that are not canonical, not indexable or not crawled alternates", () => {
    expect(hreflangIssues([page(en, [["en", en], ["de", "https://other.example/de"], ["x-default", en]])])).toEqual([]);
    expect(hreflangIssues([page(en, [["en", "https://shop.example/other"]], { canonical: "https://shop.example/other" })])).toEqual([]);
    expect(hreflangIssues([page(en, [["en", "https://shop.example/other"]], { indexable: false })])).toEqual([]);
    expect(hreflangIssues([page(en, [["en", "https://shop.example/other"]])]).map(i => i.message)).toEqual(["hreflang set does not list this page"]);
  });
});
