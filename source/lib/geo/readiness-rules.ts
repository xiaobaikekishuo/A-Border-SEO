import { contentUnits } from "@/lib/text-units";

/*
 * GEO readiness, version 3: page-level signals that make a page easier for
 * AI answer engines to read, quote and attribute. Every check uses evidence
 * saved by the crawl; nothing is fetched. A check that cannot be judged for a
 * page (an older crawl without the evidence, or a check that only applies to
 * articles) is left out of that page's denominator instead of failing it.
 *
 * Version 3 adds, from the crawl's GEO evidence (lib/crawler/geo-signals.ts):
 *   FRESHNESS  an article declares a publication or update date within the
 *              last 12 months
 *   SOURCES    an article links to at least one other site from its main
 *              content: the sources it cites
 *   RENDERING  the text is in the HTML as served, not only after JavaScript
 *              runs (many AI crawlers do not run scripts)
 * and a site-level check, the brand's entity markup (evaluateSiteEntity),
 * shown on its own rather than counted in the page score.
 *
 * This is a local checklist for finding pages to improve. It does not predict
 * citations, rankings or AI visibility.
 */

export const GEO_READINESS_VERSION = 3;
export const GEO_CHECKS = ["SNIPPET", "HEADING", "TEXT", "SECTIONS", "QUESTIONS", "FACTS", "SCHEMA", "AUTHORSHIP", "FRESHNESS", "SOURCES", "LINKS", "RENDERING"] as const;
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
  /** AuditPage.geoSignals; absent or null on crawls before version 3. */
  geoSignals?: unknown;
};

/** Main text needed before a page counts as substantive (CJK characters count one each, other text by words). */
export const MIN_CONTENT_UNITS = 250;
/** H1 plus at least two section headings. */
export const MIN_HEADINGS = 3;
/** Distinct concrete figures (amounts with units, percentages, prices, years) in the main text. */
export const MIN_FACTS = 2;
/** An article counts as fresh when its newest declared date is at most this old. */
export const FRESH_DAYS = 365;

const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report", "ScholarlyArticle", "HowTo", "Recipe"]);
const ARTICLE_PATH = /\/(?:blogs?|news|articles?|guides?|journal|posts?|stories|learn|resources|knowledge|help|faq)(?:\/|$)/i;
const QUESTION_START = /^(?:how|what|why|when|where|which|who|whom|whose|can|could|should|would|will|do|does|did|is|are|was|were|has|have)\b/i;
const QUESTION_ZH = /(?:如何|怎么|怎样|什么|为什么|为何|哪些|哪个|哪种|是否|能否|可以吗|多少|多久|多大|吗|呢)/;
// A price, a number with a unit or percent sign, or a four-digit year. Generic counters (个, 次, items) do not count.
const FACT = /(?:[$€£¥￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|％|percent|per\s?cent|kwh|kw|kg|mg|g|lbs?|oz|ml|l|cm|mm|km|m|inch(?:es)?|ft|feet|mph|mah|gb|tb|mb|hz|w|v|°c|°f|℃|days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?![A-Za-z])|\d[\d,]*(?:\.\d+)?\s?(?:元|美元|欧元|英镑|天|周|个月|月|年|小时|分钟|秒|公斤|千克|克|毫升|升|厘米|毫米|米|公里|英寸|瓦|伏|毫安时|倍)|百分之[\d一二三四五六七八九十百]+|(?<![\d.])(?:19|20)\d{2}(?!\d))/giu;

type SignalsView = { sourceLinks: number; jsShell: boolean; published: string | null; modified: string | null };
function signalsView(raw: unknown): SignalsView | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.sourceLinks !== "number" || typeof value.jsShell !== "boolean") return null;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { sourceLinks: value.sourceLinks, jsShell: value.jsShell, published: day(value.published), modified: day(value.modified) };
}

/** Whether the newest of the dates is at most FRESH_DAYS before `asOf`; false without a date. */
export function isFresh(dates: (string | null | undefined)[], asOf: Date): boolean {
  const newest = dates.filter((d): d is string => !!d).sort().pop();
  if (!newest) return false;
  const age = (asOf.getTime() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000;
  return age <= FRESH_DAYS;
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

type SchemaView = { version: number; parsedBlocks: number; errors: number; types: Set<string>; signals: {
  author?: boolean; datePublished?: boolean; dateModified?: boolean; organization?: boolean;
  organizationLogo?: boolean; organizationSameAs?: number; organizationContact?: boolean; published?: string | null; modified?: string | null;
} | null };
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

/** `asOf`: when the evidence was collected (the crawl), for the freshness check. */
export function evaluateGeoPage(page: GeoPageEvidence, asOf: Date = new Date()): GeoPageResult {
  const text = page.articleText?.trim() ?? null;
  const headings = Array.isArray(page.articleHeadings) ? page.articleHeadings.filter((h): h is string => typeof h === "string" && !!h.trim()) : null;
  const schema = schemaView(page.schemaReport);
  const article = isArticleLike(page.url, schema);
  const signals = signalsView(page.geoSignals);
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
    // The GEO evidence of version 3 crawls; older crawls cannot tell.
    FRESHNESS: !article || !signals ? null : isFresh([signals.published, signals.modified], asOf),
    SOURCES: !article || !signals ? null : signals.sourceLinks > 0,
    LINKS: page.internalLinks > 0,
    RENDERING: !signals ? null : !signals.jsShell,
  };
}

export type SiteEntity = {
  /** true: complete, false: missing parts, null: the crawl predates the evidence. */
  status: boolean | null;
  /** A named Organization, LocalBusiness or other business node on some page. */
  organization: boolean;
  logo: boolean;
  /** The most profile links (sameAs) one business node lists. */
  sameAs: number;
  contact: boolean;
  /** A page whose markup carries the most of it, preferably the home page. */
  url: string | null;
};

/**
 * The brand as an entity, judged once for the site: a named business node
 * with a logo, at least one sameAs profile (Wikipedia, Wikidata, LinkedIn,
 * official social accounts) and a way to reach it (contactPoint, telephone,
 * email or address). Answer engines use these to tell the brand apart and to
 * connect the site with what is said about it elsewhere.
 */
export function evaluateSiteEntity(pages: readonly { url: string; schemaReport: unknown }[], judged: boolean): SiteEntity {
  let best: { url: string; score: number; home: boolean } | null = null;
  const entity: SiteEntity = { status: null, organization: false, logo: false, sameAs: 0, contact: false, url: null };
  for (const page of pages) {
    const signals = schemaView(page.schemaReport)?.signals;
    if (!signals?.organization && !signals?.organizationLogo && !signals?.organizationSameAs && !signals?.organizationContact) continue;
    // The logo, sameAs and contact signals only come from named business nodes, so each implies one.
    entity.organization ||= !!signals.organization || !!signals.organizationLogo || (signals.organizationSameAs ?? 0) > 0 || !!signals.organizationContact;
    entity.logo ||= !!signals.organizationLogo;
    entity.sameAs = Math.max(entity.sameAs, signals.organizationSameAs ?? 0);
    entity.contact ||= !!signals.organizationContact;
    const score = Number(!!signals.organization) + Number(!!signals.organizationLogo) + Number((signals.organizationSameAs ?? 0) > 0) + Number(!!signals.organizationContact);
    let home = false;
    try { home = new URL(page.url).pathname === "/"; } catch { /* keep false */ }
    if (!best || score > best.score || (score === best.score && home && !best.home)) best = { url: page.url, score, home };
  }
  entity.url = best?.url ?? null;
  entity.status = judged ? entity.organization && entity.logo && entity.sameAs > 0 && entity.contact : null;
  return entity;
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
