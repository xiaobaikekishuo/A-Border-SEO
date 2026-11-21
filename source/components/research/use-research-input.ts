"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchLanguage } from "@/lib/dataforseo/market";
import { presetLanguage, useSiteMarketLanguage } from "@/components/ai-workbench/output-language";
import { appendResearchFocus, getResearchDefaults, type PromptKind } from "./research-prompt-presets";

type ResearchFields = { language: ResearchLanguage; targetMarket: string; instructions: string };

/**
 * The form of a keyword or research analysis task. It starts in the site's
 * market language until the owner picks one, and the default target market
 * and instructions follow that language while they are untouched.
 */
export function useResearchInput<I extends ResearchFields>(siteId: string, kind: PromptKind, initial: () => I) {
  const [input, setInput] = useState<I>(initial);
  const marketLanguage = useSiteMarketLanguage(siteId);
  const languageTouched = useRef(false);
  useEffect(() => {
    if (!marketLanguage || languageTouched.current) return;
    setInput(current => {
      const before = getResearchDefaults(kind, presetLanguage(current.language));
      const unchanged = current.targetMarket === before.targetMarket && current.instructions === before.instructions;
      return { ...current, language: marketLanguage, ...(unchanged ? getResearchDefaults(kind, presetLanguage(marketLanguage)) : {}) };
    });
  }, [marketLanguage, kind]);
  const patch = (value: Partial<I>) => setInput(current => ({ ...current, ...value }));
  /** The owner's choice: the market language no longer replaces it. */
  const chooseLanguage = (language: ResearchLanguage) => {
    languageTouched.current = true;
    patch({ language } as Partial<I>);
  };
  /** Adds a focus prompt to the instructions; false when they would grow past 6,000 characters. */
  const addFocus = (prompt: string) => {
    if (appendResearchFocus(input.instructions, prompt) === null) return false;
    setInput(current => ({ ...current, instructions: appendResearchFocus(current.instructions, prompt) ?? current.instructions }));
    return true;
  };
  return { input, patch, chooseLanguage, addFocus };
}
