/*
 * What a rank check costs on DataForSEO's standard queue (SERP API, Google
 * organic, normal priority), as published in November 2026. A task is billed
 * when it is posted: $0.0006 per results page of up to 10 results, so a check
 * of the first 30 results is up to three pages; loading the AI Overview adds
 * $0.0006. The estimate assumes every page is billed; Google sometimes returns
 * fewer results and DataForSEO then charges less. The real cost of each task
 * comes back when it is posted and is what the run records.
 */

export const STANDARD_PAGE_USD = 0.0006;
export const AI_OVERVIEW_USD = 0.0006;

/** Results pages one check reads and pays for. */
export function pagesFor(depth: number): number {
  return Math.max(1, Math.ceil(depth / 10));
}

/** What checking one keyword is expected to cost. */
export function checkEstimateUsd(depth: number, aiOverview: boolean): number {
  return round(pagesFor(depth) * STANDARD_PAGE_USD + (aiOverview ? AI_OVERVIEW_USD : 0));
}

/** What a run of `keywords` checks is expected to cost. */
export function estimateRankRun(keywords: number, depth: number, aiOverview: boolean): { tasks: number; usd: number } {
  return { tasks: keywords, usd: round(keywords * checkEstimateUsd(depth, aiOverview)) };
}

/** A month of runs every `days` days, for the settings screen. */
export function monthlyEstimateUsd(keywords: number, depth: number, aiOverview: boolean, days: number | null): number | null {
  if (!days || days < 1) return null;
  return round(estimateRankRun(keywords, depth, aiOverview).usd * (30 / days));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
