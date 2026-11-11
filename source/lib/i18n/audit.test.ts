import { describe, expect, it } from "vitest";
import { localizedIssueType, localizedObservation, localizedRemediation } from "./audit";
import { REMEDIATION } from "@/lib/crawler/remediation";

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
  it("uses the stored remediation text rather than assuming the enum is sufficient", () => {
    expect(localizedRemediation("MISSING_SITEMAP", REMEDIATION.SITEMAP_BLOCKED.howToFix, "zh")).toContain("Disallow");
    expect(localizedRemediation("MISSING_SITEMAP", "Custom remediation", "zh")).toBe("Custom remediation");
    expect(localizedRemediation("MISSING_TITLE", REMEDIATION.MISSING_TITLE.howToFix, "en")).toBe(REMEDIATION.MISSING_TITLE.howToFix);
  });
});
