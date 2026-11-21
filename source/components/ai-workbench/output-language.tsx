"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { defaultOutputLanguage, isResearchLanguage, RESEARCH_LANGUAGES, type ResearchLanguage } from "@/lib/dataforseo/market";

/** The site's market language (Site.researchLanguage), or null until it is known. */
export function useSiteMarketLanguage(siteId: string): ResearchLanguage | null {
  const [saved, setSaved] = useState<{siteId: string; language: ResearchLanguage} | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/research-settings`, { cache: "no-store" })
      .then(res => (res.ok ? res.json() : null))
      .then((body: { language?: unknown } | null) => {
        if (alive && isResearchLanguage(body?.language)) setSaved({ siteId, language: body.language });
      })
      .catch(() => {
        /* the interface language stays the default */
      });
    return () => {
      alive = false;
    };
  }, [siteId]);
  return saved?.siteId === siteId ? saved.language : null;
}

/**
 * The output language of a draft: the site's market language once it is
 * known, until the user picks another. Before that, the interface language.
 */
export function useOutputLanguage(siteId: string) {
  const { locale } = useI18n();
  const market = useSiteMarketLanguage(siteId);
  const [choice, setChoice] = useState<{siteId: string; language: ResearchLanguage} | null>(null);
  const language = choice?.siteId === siteId ? choice.language : defaultOutputLanguage(market, locale);
  const choose = (value: string) => {
    if (!isResearchLanguage(value)) return;
    setChoice({ siteId, language: value });
  };
  return { language, choose, market };
}

/** Chinese presets for Chinese output, English ones for every other language. */
export function presetLanguage(language: string): "zh-CN" | "en" {
  return language.startsWith("zh") ? "zh-CN" : "en";
}

/** <option>s for every output language, named in the interface language. */
export function OutputLanguageOptions() {
  const { locale } = useI18n();
  return (
    <>
      {RESEARCH_LANGUAGES.map(l => (
        <option key={l.value} value={l.value}>
          {locale === "zh" ? l.zh : l.en}
        </option>
      ))}
    </>
  );
}
