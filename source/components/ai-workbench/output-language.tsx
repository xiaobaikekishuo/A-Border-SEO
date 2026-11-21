"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { defaultOutputLanguage, isResearchLanguage, RESEARCH_LANGUAGES, type ResearchLanguage } from "@/lib/dataforseo/market";

/** The site's market language (Site.researchLanguage), or null until it is known. */
export function useSiteMarketLanguage(siteId: string): ResearchLanguage | null {
  const [language, setLanguage] = useState<ResearchLanguage | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/research-settings`, { cache: "no-store" })
      .then(res => (res.ok ? res.json() : null))
      .then((body: { language?: unknown } | null) => {
        if (alive && isResearchLanguage(body?.language)) setLanguage(body.language);
      })
      .catch(() => {
        /* the interface language stays the default */
      });
    return () => {
      alive = false;
    };
  }, [siteId]);
  return language;
}

/**
 * The output language of a draft: the site's market language once it is
 * known, until the user picks another. Before that, the interface language.
 */
export function useOutputLanguage(siteId: string) {
  const { locale } = useI18n();
  const market = useSiteMarketLanguage(siteId);
  const [language, setLanguage] = useState<ResearchLanguage>(() => defaultOutputLanguage(null, locale));
  const touched = useRef(false);
  useEffect(() => {
    if (market && !touched.current) setLanguage(market);
  }, [market]);
  const choose = (value: string) => {
    if (!isResearchLanguage(value)) return;
    touched.current = true;
    setLanguage(value);
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
