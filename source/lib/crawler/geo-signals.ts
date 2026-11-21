import { mainContentHtml } from "./article-excerpt";
import { parseAttrs, tagsNamed } from "./html-attrs";

/*
 * Page evidence for the GEO readiness checks (lib/geo/readiness-rules.ts),
 * read from the HTML as served:
 *
 *   sources   links from the main content to other sites: the sources a
 *             page cites, which answer engines can follow and quote with it
 *   jsShell   the page is an app shell whose text only appears after its
 *             JavaScript runs. The crawler does not run scripts, and many AI
 *             crawlers fetch pages the same way, so they see an empty page.
 *   dates     the newest publication and update dates the page declares
 *             (JSON-LD, meta tags, <time datetime>)
 *
 * Saved with each crawled page (AuditPage.geoSignals). Older crawls have
 * none; the checks that need them are then not judged.
 */

export const GEO_SIGNALS_VERSION = 1;

export type JsShellReason = "empty_mount" | "noscript_notice" | "no_text";

export type GeoPageSignals = {
  version: typeof GEO_SIGNALS_VERSION;
  /** Distinct links in the main content to other sites (share buttons excluded). */
  sourceLinks: number;
  /** The linked sites, up to 10. */
  sourceHosts: string[];
  jsShell: boolean;
  jsReason: JsShellReason | null;
  /** Words plus CJK characters of the served HTML text (lib/text-units.ts). */
  textUnits: number;
  /** YYYY-MM-DD, the newest found, or null. */
  published: string | null;
  modified: string | null;
};

/** Share and "post this" endpoints: buttons, not cited sources. */
const SHARE_LINK = /\/sharer?(?:\.php)?(?:[/?]|$)|\/intent\/|\/share(?:article)?(?:[/?]|$)|\/sharing\/|\/pin\/create|\/submit(?:link)?(?:[/?]|$)|^https?:\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com\/send|t\.me\/share|connect\.qq\.com|sns\.qzone\.qq\.com|service\.weibo\.com\/share)/i;
/** Second-level labels under which a country code domain registers names (example.co.uk, example.com.cn). */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gv", "mil", "ltd", "plc"]);

/** The registrable part of a host, approximately: example.com, example.co.uk. */
export function siteKey(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "").split(".");
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2])) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Links in the main content to other sites, as distinct URLs and hosts. */
export function sourceLinksOf(html: string, pageUrl: string): { count: number; hosts: string[] } {
  let own: string;
  try { own = siteKey(new URL(pageUrl).hostname); } catch { return { count: 0, hosts: [] }; }
  // Sidebars hold related links and ads rather than sources.
  const main = mainContentHtml(html).replace(/<aside\b[^>]*>[\s\S]*?<\/aside\s*>/gi, " ");
  const urls = new Set<string>();
  const hosts: string[] = [];
  for (const tag of tagsNamed(main, "a")) {
    const href = parseAttrs(tag).get("href")?.trim();
    if (!href || !/^(?:https?:)?\/\//i.test(href)) continue;
    let url: URL;
    try { url = new URL(href, pageUrl); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (siteKey(url.hostname) === own || SHARE_LINK.test(url.href)) continue;
    url.hash = "";
    if (urls.has(url.href)) continue;
    urls.add(url.href);
    const host = url.hostname.replace(/^www\./, "");
    if (hosts.length < 10 && !hosts.includes(host)) hosts.push(host);
  }
  return { count: urls.size, hosts };
}

/*
 * An empty mount element of a client-rendered app: React (root), Vue (app),
 * Next.js (__next), Nuxt (__nuxt), Angular (<app-root>) and others. Server
 * rendering fills the element, so only an empty one means "rendered later".
 */
const EMPTY_MOUNT = /<(div|main|section)\b[^>]*?\bid\s*=\s*["']?(?:root|app|__next|__nuxt|__sveltekit|svelte|q-app|ember-application|react-root|main-app)(?=["'\s/>])[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/\1\s*>/i;
const EMPTY_CUSTOM_ROOT = /<(app-root|my-app)\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/\1\s*>/i;
const NOSCRIPT_NOTICE = /<noscript\b[^>]*>(?:(?!<\/noscript)[\s\S]){0,800}?(?:enable\s+javascript|javascript\s+(?:is\s+)?(?:required|disabled|turned\s+off)|requires?\s+javascript|turn\s+on\s+javascript|启用\s*javascript|开启\s*javascript|打开\s*javascript|javascript\s*(?:已被?禁用|未启用)|需要\s*javascript|javascript\s*を有効)/i;

/** Below this much served text, an empty mount element or a "turn on JavaScript" notice marks an app shell. */
export const SHELL_MAX_UNITS = 150;

export function jsShellOf(html: string, textUnits: number): JsShellReason | null {
  if (textUnits < SHELL_MAX_UNITS && (EMPTY_MOUNT.test(html) || EMPTY_CUSTOM_ROOT.test(html))) return "empty_mount";
  if (textUnits < SHELL_MAX_UNITS && NOSCRIPT_NOTICE.test(html)) return "noscript_notice";
  if (textUnits < 20 && /<script\b/i.test(html)) return "no_text";
  return null;
}

/** A date as YYYY-MM-DD, or null. Accepts ISO 8601 dates and datetimes and other formats Date.parse reads. */
export function isoDay(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text);
  let day: string | null = null;
  if (iso) {
    const date = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === `${iso[1]}-${iso[2]}-${iso[3]}`) day = date.toISOString().slice(0, 10);
  } else if (/[a-z]{3}|\d{4}\/\d{1,2}\/\d{1,2}/i.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) day = new Date(ms).toISOString().slice(0, 10);
  }
  if (!day) return null;
  const year = Number(day.slice(0, 4));
  return year >= 1995 && year <= 2100 ? day : null;
}

const newest = (values: (string | null)[]): string | null => values.filter((v): v is string => !!v).sort().pop() ?? null;

const MODIFIED_NAMES = new Set(["article:modified_time", "og:updated_time", "dcterms.modified", "dc.date.modified", "last-modified", "lastmod", "revised", "datemodified"]);
const PUBLISHED_NAMES = new Set(["article:published_time", "dcterms.created", "dcterms.issued", "dc.date.issued", "dc.date", "date", "pubdate", "publish-date", "publish_date", "publication_date", "citation_publication_date", "parsely-pub-date", "sailthru.date", "datepublished"]);

/** Publication and update dates declared in meta tags and <time> elements (the JSON-LD ones come from the structured data report). */
export function declaredDates(html: string): { published: string | null; modified: string | null } {
  const published: (string | null)[] = [];
  const modified: (string | null)[] = [];
  for (const tag of tagsNamed(html, "meta")) {
    const attrs = parseAttrs(tag);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").trim().toLowerCase();
    if (!key) continue;
    const content = attrs.get("content");
    if (MODIFIED_NAMES.has(key)) modified.push(isoDay(content));
    else if (PUBLISHED_NAMES.has(key)) published.push(isoDay(content));
  }
  const main = mainContentHtml(html);
  let firstTime: string | null = null;
  for (const tag of tagsNamed(main, "time")) {
    const attrs = parseAttrs(tag);
    const day = isoDay(attrs.get("datetime"));
    if (!day) continue;
    const prop = (attrs.get("itemprop") ?? "").toLowerCase();
    if (prop === "datemodified") modified.push(day);
    else if (prop === "datepublished") published.push(day);
    else firstTime ??= day;
  }
  // An unlabelled <time> in the main content is most often the publication date.
  if (!published.some(Boolean) && firstTime) published.push(firstTime);
  return { published: newest(published), modified: newest(modified) };
}

export function geoPageSignals(
  html: string,
  pageUrl: string,
  input: { textUnits: number; schemaDates?: { published?: string | null; modified?: string | null } }
): GeoPageSignals {
  const sources = sourceLinksOf(html, pageUrl);
  const dates = declaredDates(html);
  const jsReason = jsShellOf(html, input.textUnits);
  return {
    version: GEO_SIGNALS_VERSION,
    sourceLinks: sources.count,
    sourceHosts: sources.hosts,
    jsShell: jsReason !== null,
    jsReason,
    textUnits: input.textUnits,
    published: newest([dates.published, isoDay(input.schemaDates?.published)]),
    modified: newest([dates.modified, isoDay(input.schemaDates?.modified)]),
  };
}
