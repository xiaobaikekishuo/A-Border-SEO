import { describe, expect, it } from "vitest";
import { localizedIssueType, localizedObservation, localizedRemediation } from "./audit";
import { LEGACY_HOW_TO_FIX, REMEDIATION } from "@/lib/crawler/remediation";

describe("localized audit presentation", () => {
  it("translates known observations and preserves their counts", () => {
    expect(localizedObservation("Duplicate title shared by 45 pages", "zh")).toBe("45 个页面共用相同标题");
    expect(localizedObservation("49 reviewed false positives excluded; 2 findings unverified and not deducted from health. Original observations are retained.", "zh")).toContain("49 条经复核的误报；2 条尚未核实");
    expect(localizedIssueType("ORPHAN_CANDIDATE", "zh")).toBe("疑似孤立页");
    expect(localizedObservation("18 of 20 pages are noindex. If that is not intended, search engines will drop them.", "zh")).toContain("20 个页面中有 18 个");
    expect(localizedObservation("Crawl-delay 5s: stopped early after 1 request, the rest does not fit in the 30-minute crawl limit", "zh")).toContain("1 个请求");
  });
  it("keeps URLs and unknown observations literal", () => {
    const url = "https://example.test/中文/{title}?q=Keywords";
    expect(localizedObservation(`2 landing pages competing · top: ${url}`, "zh")).toBe(`2 个落地页相互竞争 · 主要页面：${url}`);
    expect(localizedObservation("A user-authored English title", "zh")).toBe("A user-authored English title");
    expect(localizedObservation("Duplicate title shared by 45 pages", "en")).toBe("Duplicate title shared by 45 pages");
  });
  it("translates redirect and hreflang findings, with the count of further problems", () => {
    expect(localizedIssueType("HREFLANG", "zh")).toBe("hreflang 问题");
    expect(localizedObservation("Redirect chain: 2 hops to https://example.test/new", "zh")).toBe("重定向链：经过 2 次跳转才到达 https://example.test/new");
    expect(localizedObservation("1 internal link points to a redirect (301) → https://example.test/b", "zh")).toBe("1 个站内链接指向重定向网址（301）→ https://example.test/b");
    expect(localizedObservation("3 internal links point to a redirect (308) → https://example.test/b", "zh")).toBe("3 个站内链接指向重定向网址（308）→ https://example.test/b");
    expect(localizedObservation("Sitemap lists a redirecting URL (301) → https://example.test/b", "zh")).toContain("站点地图");
    expect(localizedObservation('Invalid hreflang value "en_GB" (+3 more)', "zh")).toBe('hreflang 值无效："en_GB"（另有 3 项）');
    expect(localizedObservation('hreflang "de" points to a noindex URL: https://example.test/de', "zh")).toBe('hreflang "de" 指向设置了 noindex 的网址：https://example.test/de');
    expect(localizedObservation("hreflang set has no x-default", "zh")).toBe("hreflang 组缺少 x-default");
    expect(localizedRemediation("HREFLANG", REMEDIATION.HREFLANG.howToFix, "zh")).toContain("x-default");
    expect(localizedRemediation("REDIRECT", REMEDIATION.REDIRECT.howToFix, "zh")).toContain("站点地图");
  });
  it("shows the corrected structured data advice for findings stored with the retired FAQPage text", () => {
    const retired = Object.keys(LEGACY_HOW_TO_FIX).find((text) => text.includes("FAQPage"))!;
    expect(retired).toBeTruthy();
    expect(localizedRemediation("MISSING_SCHEMA", retired, "en")).toBe(REMEDIATION.MISSING_SCHEMA.howToFix);
    expect(localizedRemediation("MISSING_SCHEMA", retired, "zh")).toContain("BreadcrumbList");
    expect(localizedRemediation("MISSING_SCHEMA", retired, "zh")).toContain("不再产生 Google 富结果");
    expect(localizedRemediation("MISSING_SCHEMA", "Custom advice", "zh")).toBe("Custom advice");
  });
  it("never recommends a rich result type Google has retired", () => {
    for (const [type, { howToFix }] of Object.entries(REMEDIATION)) {
      for (const text of [howToFix, localizedRemediation(type, howToFix, "zh")]) {
        // Every sentence naming FAQPage or HowTo must say it no longer produces rich results.
        for (const sentence of text.split(/(?<=[.;。；])\s*/)) {
          if (/FAQPage|HowTo/.test(sentence)) expect(sentence).toMatch(/no longer|不再/);
        }
      }
    }
  });
  it("uses the stored remediation text rather than assuming the enum is sufficient", () => {
    expect(localizedRemediation("MISSING_SITEMAP", REMEDIATION.SITEMAP_BLOCKED.howToFix, "zh")).toContain("Disallow");
    expect(localizedRemediation("MISSING_SITEMAP", "Custom remediation", "zh")).toBe("Custom remediation");
    expect(localizedRemediation("MISSING_TITLE", REMEDIATION.MISSING_TITLE.howToFix, "en")).toBe(REMEDIATION.MISSING_TITLE.howToFix);
  });
});
