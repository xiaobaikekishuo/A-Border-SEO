import { describe, expect, it } from "vitest";
import { marketSupport, parseLabsCatalog } from "./labs-catalog";
import { languageName, RESEARCH_LANGUAGE_CODES, RESEARCH_LANGUAGES, RESEARCH_LOCATIONS, validMarket, defaultOutputLanguage } from "./market";

const catalog = {
  tasks: [{
    status_code: 20000,
    result: [
      { location_code: 2840, location_name: "United States", available_languages: [{ language_code: "en", available_sources: ["google", "bing"] }, { language_code: "es", available_sources: ["google"] }] },
      { location_code: 2410, location_name: "South Korea", available_languages: [{ language_code: "ko", available_sources: ["google"] }, { language_code: "en", available_sources: ["bing"] }] },
    ],
  }],
};

describe("DataForSEO Labs catalog", () => {
  it("reads which languages each location has Google data for", () => {
    const parsed = parseLabsCatalog(catalog)!;
    expect([...parsed.get(2840)!]).toEqual(["en", "es"]);
    expect([...parsed.get(2410)!]).toEqual(["ko"]);
    expect(marketSupport(parsed, { language: "ko", location: 2410 })).toBe("SUPPORTED");
    expect(marketSupport(parsed, { language: "en", location: 2410 })).toBe("UNSUPPORTED");
    expect(marketSupport(parsed, { language: "de", location: 2276 })).toBe("UNSUPPORTED");
    expect(marketSupport(null, { language: "de", location: 2276 })).toBe("UNKNOWN");
  });

  it("does not trust an error or an empty answer", () => {
    expect(parseLabsCatalog({ tasks: [{ status_code: 40100, result: null }] })).toBeNull();
    expect(parseLabsCatalog({ tasks: [{ status_code: 20000, result: [] }] })).toBeNull();
    expect(parseLabsCatalog(null)).toBeNull();
  });
});

describe("research markets", () => {
  it("offers only known languages for every location, each location once", () => {
    const languages = new Set(RESEARCH_LANGUAGES.map(l => l.value));
    expect(new Set(RESEARCH_LOCATIONS.map(l => l.value)).size).toBe(RESEARCH_LOCATIONS.length);
    for (const location of RESEARCH_LOCATIONS) {
      const offered = RESEARCH_LANGUAGE_CODES[location.value];
      expect(offered?.length, location.en).toBeGreaterThan(0);
      for (const code of offered) expect(languages.has(code as never), `${location.en} ${code}`).toBe(true);
      expect(location.iso).toMatch(/^[A-Z]{2}$/);
    }
    expect(validMarket({ language: "ko", location: 2410 })).toBe(true);
    expect(validMarket({ language: "ko", location: 2840 })).toBe(false);
  });

  it("names the output language for prompts and starts drafts in the site's language", () => {
    expect(languageName("zh-CN")).toBe("Simplified Chinese");
    expect(languageName("en")).toBe("English");
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("xx")).toBe("English");
    expect(defaultOutputLanguage("ja", "zh")).toBe("ja");
    expect(defaultOutputLanguage(undefined, "zh")).toBe("zh-CN");
    expect(defaultOutputLanguage("klingon", "en")).toBe("en");
  });
});
