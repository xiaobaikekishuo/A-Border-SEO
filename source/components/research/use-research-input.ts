"use client";

import { useState } from "react";
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
  const [draft, setInput] = useState<I>(initial);
  const marketLanguage = useSiteMarketLanguage(siteId);
  const [languageTouched, setLanguageTouched] = useState(false);
  let input = draft;
  if (marketLanguage && !languageTouched && marketLanguage !== draft.language) {
    const before = getResearchDefaults(kind, presetLanguage(draft.language));
    const unchanged = draft.targetMarket === before.targetMarket && draft.instructions === before.instructions;
    input = { ...draft, language: marketLanguage, ...(unchanged ? getResearchDefaults(kind, presetLanguage(marketLanguage)) : {}) };
  }
  const patch = (value: Partial<I>) => setInput({ ...input, ...value });
  /** The owner's choice: the market language no longer replaces it. */
  const chooseLanguage = (language: ResearchLanguage) => {
    setLanguageTouched(true);
    patch({ language } as Partial<I>);
  };
  /** Adds a focus prompt to the instructions; false when they would grow past 6,000 characters. */
  const addFocus = (prompt: string) => {
    const instructions = appendResearchFocus(input.instructions, prompt);
    if (instructions === null) return false;
    setInput({ ...input, instructions });
    return true;
  };
  return { input, patch, chooseLanguage, addFocus };
}
