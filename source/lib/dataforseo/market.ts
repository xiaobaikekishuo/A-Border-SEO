/*
 * Research markets: the country (DataForSEO location code, which is Google
 * Ads' geo target id) and the content language of a site's paid research and
 * prompt tracking. Saved per site (Site.researchLanguage / researchLocation).
 *
 * `name` is the language as written in prompts to the AI workbench, which
 * drafts in the site's market language by default.
 */

export const RESEARCH_LANGUAGES = [
  { value: "en", en: "English", zh: "英语", name: "English" },
  { value: "zh-CN", en: "Chinese (Simplified)", zh: "简体中文", name: "Simplified Chinese" },
  { value: "zh-TW", en: "Chinese (Traditional)", zh: "繁体中文", name: "Traditional Chinese" },
  { value: "ja", en: "Japanese", zh: "日语", name: "Japanese" },
  { value: "ko", en: "Korean", zh: "韩语", name: "Korean" },
  { value: "de", en: "German", zh: "德语", name: "German" },
  { value: "fr", en: "French", zh: "法语", name: "French" },
  { value: "es", en: "Spanish", zh: "西班牙语", name: "Spanish" },
  { value: "pt", en: "Portuguese", zh: "葡萄牙语", name: "Portuguese" },
  { value: "it", en: "Italian", zh: "意大利语", name: "Italian" },
  { value: "nl", en: "Dutch", zh: "荷兰语", name: "Dutch" },
  { value: "sv", en: "Swedish", zh: "瑞典语", name: "Swedish" },
  { value: "da", en: "Danish", zh: "丹麦语", name: "Danish" },
  { value: "fi", en: "Finnish", zh: "芬兰语", name: "Finnish" },
  { value: "pl", en: "Polish", zh: "波兰语", name: "Polish" },
  { value: "cs", en: "Czech", zh: "捷克语", name: "Czech" },
  { value: "tr", en: "Turkish", zh: "土耳其语", name: "Turkish" },
  { value: "ar", en: "Arabic", zh: "阿拉伯语", name: "Arabic" },
  { value: "he", en: "Hebrew", zh: "希伯来语", name: "Hebrew" },
  { value: "hi", en: "Hindi", zh: "印地语", name: "Hindi" },
  { value: "id", en: "Indonesian", zh: "印尼语", name: "Indonesian" },
  { value: "ms", en: "Malay", zh: "马来语", name: "Malay" },
  { value: "th", en: "Thai", zh: "泰语", name: "Thai" },
  { value: "vi", en: "Vietnamese", zh: "越南语", name: "Vietnamese" },
] as const;
export type ResearchLanguage = (typeof RESEARCH_LANGUAGES)[number]["value"];
export const RESEARCH_LANGUAGE_VALUES = RESEARCH_LANGUAGES.map(l => l.value) as unknown as readonly [ResearchLanguage, ...ResearchLanguage[]];

/** `iso`: ISO 3166-1 alpha-2, for the providers that take a country code (Perplexity, Claude web search). */
export const RESEARCH_LOCATIONS = [
  { value: 2840, iso: "US", en: "United States", zh: "美国" }, { value: 2826, iso: "GB", en: "United Kingdom", zh: "英国" },
  { value: 2124, iso: "CA", en: "Canada", zh: "加拿大" }, { value: 2036, iso: "AU", en: "Australia", zh: "澳大利亚" },
  { value: 2554, iso: "NZ", en: "New Zealand", zh: "新西兰" }, { value: 2372, iso: "IE", en: "Ireland", zh: "爱尔兰" },
  { value: 2702, iso: "SG", en: "Singapore", zh: "新加坡" }, { value: 2344, iso: "HK", en: "Hong Kong", zh: "香港" },
  { value: 2158, iso: "TW", en: "Taiwan", zh: "台湾" }, { value: 2392, iso: "JP", en: "Japan", zh: "日本" },
  { value: 2410, iso: "KR", en: "South Korea", zh: "韩国" }, { value: 2356, iso: "IN", en: "India", zh: "印度" },
  { value: 2360, iso: "ID", en: "Indonesia", zh: "印度尼西亚" }, { value: 2458, iso: "MY", en: "Malaysia", zh: "马来西亚" },
  { value: 2608, iso: "PH", en: "Philippines", zh: "菲律宾" }, { value: 2764, iso: "TH", en: "Thailand", zh: "泰国" },
  { value: 2704, iso: "VN", en: "Vietnam", zh: "越南" }, { value: 2276, iso: "DE", en: "Germany", zh: "德国" },
  { value: 2040, iso: "AT", en: "Austria", zh: "奥地利" }, { value: 2756, iso: "CH", en: "Switzerland", zh: "瑞士" },
  { value: 2250, iso: "FR", en: "France", zh: "法国" }, { value: 2056, iso: "BE", en: "Belgium", zh: "比利时" },
  { value: 2528, iso: "NL", en: "Netherlands", zh: "荷兰" }, { value: 2724, iso: "ES", en: "Spain", zh: "西班牙" },
  { value: 2620, iso: "PT", en: "Portugal", zh: "葡萄牙" }, { value: 2380, iso: "IT", en: "Italy", zh: "意大利" },
  { value: 2752, iso: "SE", en: "Sweden", zh: "瑞典" }, { value: 2208, iso: "DK", en: "Denmark", zh: "丹麦" },
  { value: 2246, iso: "FI", en: "Finland", zh: "芬兰" }, { value: 2616, iso: "PL", en: "Poland", zh: "波兰" },
  { value: 2203, iso: "CZ", en: "Czechia", zh: "捷克" }, { value: 2792, iso: "TR", en: "Turkey", zh: "土耳其" },
  { value: 2784, iso: "AE", en: "United Arab Emirates", zh: "阿联酋" }, { value: 2682, iso: "SA", en: "Saudi Arabia", zh: "沙特阿拉伯" },
  { value: 2376, iso: "IL", en: "Israel", zh: "以色列" }, { value: 2076, iso: "BR", en: "Brazil", zh: "巴西" },
  { value: 2484, iso: "MX", en: "Mexico", zh: "墨西哥" }, { value: 2032, iso: "AR", en: "Argentina", zh: "阿根廷" },
  { value: 2170, iso: "CO", en: "Colombia", zh: "哥伦比亚" }, { value: 2152, iso: "CL", en: "Chile", zh: "智利" },
  { value: 2710, iso: "ZA", en: "South Africa", zh: "南非" },
] as const;

/**
 * The languages offered per location. The first ten locations' pairs come
 * from the provider's locations-and-languages catalog, checked 2026-11-05.
 * The others were added 2026-11-18 with each country's main languages; when
 * a DataForSEO login is saved, saving a market also checks the pair against
 * the live DataForSEO Labs catalog (lib/dataforseo/labs-catalog.ts).
 */
export const RESEARCH_LANGUAGE_CODES: Record<number, readonly string[]> = {
  2036: ["en"], 2124: ["en", "fr"], 2158: ["zh-TW"], 2250: ["fr"], 2276: ["de"],
  2344: ["en", "zh-TW"], 2392: ["ja"], 2702: ["en", "zh-CN"], 2826: ["en"], 2840: ["en", "es"],
  // Added 2026-11-18.
  2554: ["en"], 2372: ["en"], 2410: ["ko"], 2356: ["en", "hi"], 2360: ["id"], 2458: ["ms", "en"],
  2608: ["en"], 2764: ["th"], 2704: ["vi"], 2040: ["de"], 2756: ["de", "fr", "it"], 2056: ["nl", "fr"],
  2528: ["nl"], 2724: ["es"], 2620: ["pt"], 2380: ["it"], 2752: ["sv"], 2208: ["da"], 2246: ["fi"],
  2616: ["pl"], 2203: ["cs"], 2792: ["tr"], 2784: ["ar", "en"], 2682: ["ar"], 2376: ["he"],
  2076: ["pt"], 2484: ["es"], 2032: ["es"], 2170: ["es"], 2152: ["es"], 2710: ["en"],
};

export type ResearchMarket = { language: string; location: number };
export function validMarket(value: unknown): value is ResearchMarket {
  const m = value as ResearchMarket | null;
  return !!m && RESEARCH_LANGUAGES.some(l => l.value === m.language) && RESEARCH_LOCATIONS.some(l => l.value === m.location) && RESEARCH_LANGUAGE_CODES[m.location]?.includes(m.language);
}
export function siteMarket(site: { researchLanguage?: string; researchLocation?: number }): ResearchMarket {
  return { language: site.researchLanguage ?? "en", location: site.researchLocation ?? 2840 };
}

/** ISO 3166-1 alpha-2 country of a location code, or null. */
export function locationIso(location: number): string | null {
  return RESEARCH_LOCATIONS.find(l => l.value === location)?.iso ?? null;
}

export function isResearchLanguage(value: unknown): value is ResearchLanguage {
  return typeof value === "string" && RESEARCH_LANGUAGES.some(l => l.value === value);
}

/** The language name used in prompts ("Simplified Chinese"); English for anything unknown. */
export function languageName(code: string): string {
  return RESEARCH_LANGUAGES.find(l => l.value === code)?.name ?? "English";
}

/**
 * The output language a draft starts with: the site's market language when
 * it is one the workbench writes, otherwise the interface language.
 */
export function defaultOutputLanguage(siteLanguage: string | null | undefined, uiLocale: "zh" | "en"): ResearchLanguage {
  if (isResearchLanguage(siteLanguage)) return siteLanguage;
  return uiLocale === "zh" ? "zh-CN" : "en";
}
