import { describe, expect, it } from "vitest";
import { AI_BOTS } from "@/lib/seo/ai-bots";
import { REFERRAL_PLATFORMS } from "./import";
import { GEO_PLATFORM_IDS, GEO_PLATFORMS, geoPlatform, isGeoPlatformId, probeCrawlers, TRACKED_PLATFORMS } from "./platforms";

describe("GEO platform registry", () => {
  it("lists the ten platforms once each, in the declared order", () => {
    expect(GEO_PLATFORMS.map(p => p.id)).toEqual([...GEO_PLATFORM_IDS]);
    expect(new Set(GEO_PLATFORM_IDS).size).toBe(10);
    expect(isGeoPlatformId("CHATGPT")).toBe(true);
    expect(isGeoPlatformId("chatgpt")).toBe(false);
    expect(geoPlatform("COPILOT")?.index).toBe("BING");
  });

  it("names only crawler and control tokens the shared bot registry knows", () => {
    const tokens = new Set(AI_BOTS.map(bot => bot.token));
    for (const platform of GEO_PLATFORMS) {
      for (const crawler of platform.crawlers) {
        expect(tokens.has(crawler.token), crawler.token).toBe(true);
        expect(crawler.userAgent.toLowerCase(), crawler.token).toContain(crawler.token.toLowerCase());
        expect(crawler.userAgent).not.toMatch(/https?:/);
      }
      for (const token of platform.controlTokens) expect(tokens.has(token), token).toBe(true);
    }
  });

  it("uses the referral names of the GA4 import", () => {
    for (const platform of GEO_PLATFORMS) {
      for (const name of platform.referrers) expect(REFERRAL_PLATFORMS, name).toContain(name);
    }
  });

  it("asks through DataForSEO exactly the platforms it can answer for", () => {
    expect([...TRACKED_PLATFORMS].sort()).toEqual(["CHATGPT", "CLAUDE", "GEMINI", "GOOGLE_AIO", "GOOGLE_AI_MODE", "PERPLEXITY"]);
    for (const id of ["COPILOT", "GROK", "META_AI", "DEEPSEEK"] as const) expect(geoPlatform(id)?.answers.kind).toBe("MANUAL");
  });

  it("probes each AI crawler once and never imitates the search engine crawlers", () => {
    const tokens = probeCrawlers().map(c => c.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toContain("OAI-SearchBot");
    expect(tokens).toContain("PerplexityBot");
    expect(tokens).not.toContain("Googlebot");
    expect(tokens).not.toContain("Bingbot");
    expect(tokens).not.toContain("Google-Extended");
    expect(tokens).toHaveLength(10);
  });
});
