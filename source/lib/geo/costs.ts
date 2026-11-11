import type { GeoPlatformId } from "./platforms";

/**
 * What one task costs, as published in November 2026, for the estimate shown
 * before a run and for the budget check. Live LLM Scraper and Google AI Mode
 * tasks are $0.004; the organic page with the AI Overview loaded is $0.002
 * plus $0.002; LLM Responses tasks are $0.0006 plus the model's own charges,
 * which depend on the answer length and web searches, so those are rough.
 */
export const TASK_ESTIMATE_USD: Partial<Record<GeoPlatformId, number>> = {
  CHATGPT: 0.004,
  GEMINI: 0.004,
  GOOGLE_AIO: 0.004,
  GOOGLE_AI_MODE: 0.004,
  PERPLEXITY: 0.01,
  CLAUDE: 0.04,
};
