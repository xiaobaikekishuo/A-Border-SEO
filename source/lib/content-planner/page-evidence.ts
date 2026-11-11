import type { AuditPage } from "@prisma/client";
import { siteUrl } from "./schema";
import type { ImportablePage } from "./types";

export const importPageColumns = {
  id: true, url: true, title: true, h1s: true, h1Count: true, wordCount: true, statusCode: true,
} as const;
type PageEvidence = Pick<AuditPage, keyof typeof importPageColumns>;
const ASSET_EXTENSION = /\.(?:avif|bmp|css|csv|eot|gif|ico|jpe?g|js|json|map|mjs|mp[34]|pdf|png|rss|svg|tar|tgz|txt|webm|webp|woff2?|xml|zip)$/i;
const ARTICLE_PATH = /\/(?:articles?|blogs?|posts?|guides?|news|learn|resources?)\/[^/]+/i;
const ARTICLE_INDEX = /\/(?:articles?|blogs?|posts?|guides?|news|learn|resources?)\/?$/i;
const SYSTEM_PATH = /^\/(?:products?|collections?|categor(?:y|ies)|tags?|cart|checkout|account|search)(?:\/|$)/i;
const TAXONOMY_PATH = /\/(?:categor(?:y|ies)|tags?)(?:\/|$)/i;
const EDITORIAL_HEADING = /(?:指南|教程|攻略|方法|区别|如何|怎么|检查清单|常见问题|\b(?:how to|guide|tutorial|checklist|comparison|explained)\b)/i;

export function sameSitePageUrl(raw: string, domain: string): string | null {
  try {
    // Stored crawl evidence must already contain an absolute URL.
    new URL(raw);
    return siteUrl(raw, domain);
  } catch { return null; }
}

/** AuditPage does not retain MIME type, so HTML and article labels are conservative hints. */
export function importablePage(page: PageEvidence, domain: string): ImportablePage | null {
  if (page.statusCode < 200 || page.statusCode >= 300) return null;
  const url = sameSitePageUrl(page.url, domain);
  if (!url) return null;
  const pathname = new URL(url).pathname;
  if (ASSET_EXTENSION.test(pathname)) return null;
  const headings = Array.isArray(page.h1s) ? page.h1s.filter((h): h is string => typeof h === "string" && !!h.trim()) : [];
  const rawTitle = page.title?.trim() ?? "";
  if (!rawTitle && !headings.length && page.h1Count === 0 && page.wordCount === 0) return null;
  const lastSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
  let pathLabel = lastSegment;
  try { pathLabel = decodeURIComponent(lastSegment).replace(/[-_]+/g, " "); } catch { /* Keep the recorded path when decoding fails. */ }
  const title = (rawTitle || headings[0]?.trim() || pathLabel || url).slice(0, 250);
  const suggestedKeyword = (headings[0]?.trim() || rawTitle || pathLabel || url).slice(0, 250);
  const articleCandidate = !SYSTEM_PATH.test(pathname) && !ARTICLE_INDEX.test(pathname) && !TAXONOMY_PATH.test(pathname) && pathname !== "/" &&
    (ARTICLE_PATH.test(pathname) || headings.some((heading) => EDITORIAL_HEADING.test(heading)));
  return { id: page.id, url, title, suggestedKeyword, articleCandidate };
}
