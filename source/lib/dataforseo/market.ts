export const RESEARCH_LANGUAGES = [
  { value: "en", en: "English", zh: "英语" }, { value: "zh-CN", en: "Chinese (Simplified)", zh: "简体中文" },
  { value: "zh-TW", en: "Chinese (Traditional)", zh: "繁体中文" }, { value: "ja", en: "Japanese", zh: "日语" },
  { value: "de", en: "German", zh: "德语" }, { value: "fr", en: "French", zh: "法语" }, { value: "es", en: "Spanish", zh: "西班牙语" },
] as const;
export const RESEARCH_LOCATIONS = [
  { value: 2840, en: "United States", zh: "美国" }, { value: 2826, en: "United Kingdom", zh: "英国" },
  { value: 2124, en: "Canada", zh: "加拿大" }, { value: 2036, en: "Australia", zh: "澳大利亚" },
  { value: 2702, en: "Singapore", zh: "新加坡" }, { value: 2344, en: "Hong Kong", zh: "香港" },
  { value: 2158, en: "Taiwan", zh: "台湾" }, { value: 2392, en: "Japan", zh: "日本" },
  { value: 2276, en: "Germany", zh: "德国" }, { value: 2250, en: "France", zh: "法国" },
] as const;
// Supported pairs from the provider's locations-and-languages catalog, checked 2026-11-05.
export const RESEARCH_LANGUAGE_CODES: Record<number, readonly string[]> = {
  2036: ["en"], 2124: ["en", "fr"], 2158: ["zh-TW"], 2250: ["fr"], 2276: ["de"],
  2344: ["en", "zh-TW"], 2392: ["ja"], 2702: ["en", "zh-CN"], 2826: ["en"], 2840: ["en", "es"],
};
export type ResearchMarket = { language: string; location: number };
export function validMarket(value: unknown): value is ResearchMarket {
  const m = value as ResearchMarket | null;
  return !!m && RESEARCH_LANGUAGES.some(l => l.value === m.language) && RESEARCH_LOCATIONS.some(l => l.value === m.location) && RESEARCH_LANGUAGE_CODES[m.location]?.includes(m.language);
}
export function siteMarket(site: { researchLanguage?: string; researchLocation?: number }): ResearchMarket {
  return { language: site.researchLanguage ?? "en", location: site.researchLocation ?? 2840 };
}
