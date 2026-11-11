/*
 * GEO readiness, version 2: page-level signals that make a page easier for
 * AI answer engines to read, quote and attribute. Every check uses evidence
 * saved by the crawl; nothing is fetched. A check that cannot be judged for a
 * page (an older crawl without the evidence, or a check that only applies to
 * articles) is left out of that page's denominator instead of failing it.
 *
 * This is a local checklist for finding pages to improve. It does not predict
 * citations, rankings or AI visibility.
 */

export const GEO_READINESS_VERSION = 2;
export const GEO_CHECKS = ["SNIPPET", "HEADING", "TEXT", "SECTIONS", "QUESTIONS", "FACTS", "SCHEMA", "AUTHORSHIP", "LINKS"] as const;
export type GeoCheckKey = typeof GEO_CHECKS[number];
/** true: passed, false: failed, null: not applicable or not judged for this page. */
export type GeoPageResult = Record<GeoCheckKey, boolean | null>;

export type GeoPageEvidence = {
  url: string;
  title: string | null;
  description: string | null;
  h1Count: number;
  wordCount: number;
  internalLinks: number;
  articleText: string | null;
  articleHeadings: unknown;
  schemaReport: unknown;
};

/** Main text needed before a page counts as substantive (CJK characters count one each, other text by words). */
export const MIN_CONTENT_UNITS = 250;
/** H1 plus at least two section headings. */
export const MIN_HEADINGS = 3;
/** Distinct concrete figures (amounts with units, percentages, prices, years) in the main text. */
export const MIN_FACTS = 2;

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report", "ScholarlyArticle", "HowTo", "Recipe"]);
const ARTICLE_PATH = /\/(?:blogs?|news|articles?|guides?|journal|posts?|stories|learn|resources|knowledge|help|faq)(?:\/|$)/i;
const QUESTION_START = /^(?:how|what|why|when|where|which|who|whom|whose|can|could|should|would|will|do|does|did|is|are|was|were|has|have)\b/i;
const QUESTION_ZH = /(?:如何|怎么|怎样|什么|为什么|为何|哪些|哪个|哪种|是否|能否|可以吗|多少|多久|多大|吗|呢)/;
// A price, a number with a unit or percent sign, or a four-digit year. Generic counters (个, 次, items) do not count.
const FACT = /(?:[$€£¥￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|％|percent|per\s?cent|kwh|kw|kg|mg|g|lbs?|oz|ml|l|cm|mm|km|m|inch(?:es)?|ft|feet|mph|mah|gb|tb|mb|hz|w|v|°c|°f|℃|days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?![A-Za-z])|\d[\d,]*(?:\.\d+)?\s?(?:元|美元|欧元|英镑|天|周|个月|月|年|小时|分钟|秒|公斤|千克|克|毫升|升|厘米|毫米|米|公里|英寸|瓦|伏|毫安时|倍)|百分之[\d一二三四五六七八九十百]+|(?<![\d.])(?:19|20)\d{2}(?!\d))/giu;

function contentUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  return cjk + words;
}

export function isQuestionHeading(heading: string): boolean {
  const value = heading.trim();
  if (!value) return false;
  if (/[?？]\s*$/.test(value)) return true;
  return QUESTION_START.test(value) || QUESTION_ZH.test(value);
}

export function factCount(text: string): number {
  const seen = new Set<string>();
  for (const match of text.matchAll(FACT)) {
    seen.add(match[0].toLowerCase().replace(/\s+/g, ""));
    if (seen.size >= 20) break;
  }
  return seen.size;
}

type SchemaView = { version: number; parsedBlocks: number; errors: number; types: Set<string>; signals: { author?: boolean; datePublished?: boolean; dateModified?: boolean } | null };
function schemaView(raw: unknown): SchemaView | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (![1, 2].includes(value.version as number) || !Array.isArray(value.findings) || !Array.isArray(value.entities)) return null;
  const types = new Set<string>();
  for (const entity of value.entities) {
    const list = entity && typeof entity === "object" ? (entity as { types?: unknown }).types : null;
    if (Array.isArray(list)) for (const type of list) if (typeof type === "string") types.add(type);
  }
  const errors = value.findings.filter(finding => finding && typeof finding === "object" && (finding as { severity?: unknown }).severity === "ERROR").length;
  const signals = value.signals && typeof value.signals === "object" ? value.signals as SchemaView["signals"] : null;
  return { version: value.version as number, parsedBlocks: typeof value.parsedBlocks === "number" ? value.parsedBlocks : 0, errors, types, signals };
}

/** Article-like pages: Article-family markup, or a blog/news/guide style path. */
export function isArticleLike(url: string, schema: SchemaView | null): boolean {
  if (schema && [...schema.types].some(type => ARTICLE_TYPES.has(type))) return true;
  try { return ARTICLE_PATH.test(new URL(url).pathname); } catch { return false; }
}

export function evaluateGeoPage(page: GeoPageEvidence): GeoPageResult {
  const text = page.articleText?.trim() ?? null;
  const headings = Array.isArray(page.articleHeadings) ? page.articleHeadings.filter((h): h is string => typeof h === "string" && !!h.trim()) : null;
  const schema = schemaView(page.schemaReport);
  const article = isArticleLike(page.url, schema);
  return {
    SNIPPET: !!page.title?.trim() && !!page.description?.trim(),
    HEADING: page.h1Count > 0,
    TEXT: text !== null ? contentUnits(text) >= MIN_CONTENT_UNITS : page.wordCount >= MIN_CONTENT_UNITS,
    SECTIONS: headings === null ? null : headings.length >= MIN_HEADINGS,
    QUESTIONS: headings === null || !article ? null : headings.some(isQuestionHeading),
    FACTS: text === null ? null : factCount(text) >= MIN_FACTS,
    SCHEMA: page.schemaReport === null || page.schemaReport === undefined ? null : !!schema && schema.parsedBlocks > 0 && schema.errors === 0,
    // Author and dates come from version 2 schema reports; older reports cannot tell.
    AUTHORSHIP: !article || !schema || schema.version < 2 || !schema.signals ? null : !!schema.signals.author && !!(schema.signals.datePublished || schema.signals.dateModified),
    LINKS: page.internalLinks > 0,
  };
}

export type GeoCheckTotals = { key: GeoCheckKey; passed: number; applicable: number };
export function summarizeGeoPages(results: GeoPageResult[]): { checks: GeoCheckTotals[]; score: number | null } {
  const checks = GEO_CHECKS.map(key => ({
    key,
    passed: results.filter(result => result[key] === true).length,
    applicable: results.filter(result => result[key] !== null).length,
  }));
  const applicable = checks.reduce((sum, check) => sum + check.applicable, 0);
  const passed = checks.reduce((sum, check) => sum + check.passed, 0);
  return { checks, score: applicable ? Math.round((100 * passed) / applicable) : null };
}
