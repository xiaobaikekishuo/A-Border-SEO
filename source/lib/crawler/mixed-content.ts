import { parseAttrs } from "./html-attrs";

/*
 * Mixed content: an HTTPS page that loads part of itself (a script, style
 * sheet, image, frame, media file, font) over plain HTTP. Browsers block or
 * flag those requests. A link to an http:// page (<a href>) is navigation,
 * not mixed content, and neither is <link rel=canonical|alternate|…>: they
 * load nothing into the page. The previous check matched any `href="http://`
 * and so reported pages that merely link to an HTTP site.
 *
 * Only the served HTML is read: resources added later by JavaScript, and
 * url() references inside external style sheets, are not seen.
 */

export type InsecureKind = "script" | "stylesheet" | "image" | "media" | "frame" | "object" | "css" | "form" | "base" | "other";
export type InsecureResource = { kind: InsecureKind; url: string };

/** <link rel> values that make the browser fetch the href. */
const LINK_FETCHES: Record<string, InsecureKind> = {
  stylesheet: "stylesheet", preload: "other", modulepreload: "script", prefetch: "other", manifest: "other",
  icon: "image", "apple-touch-icon": "image", "apple-touch-icon-precomposed": "image", "mask-icon": "image",
};
/** What <link rel=preload|prefetch> fetches, by its `as` attribute; fonts and fetches stay "other". */
const PRELOAD_AS: Record<string, InsecureKind> = {
  script: "script", worker: "script", sharedworker: "script", serviceworker: "script", style: "stylesheet",
  image: "image", audio: "media", video: "media", track: "media",
};

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const CSS_URL = /url\(\s*(["']?)\s*(http:\/\/[^"')\s]+)/gi;
const CSS_IMPORT = /@import\s+(["'])\s*(http:\/\/[^"'\s]+)/gi;

const insecure = (value: string | undefined): value is string => !!value && /^\s*http:\/\//i.test(value);

/** The http:// candidates of a srcset ("a.jpg 1x, http://x/b.jpg 2x"). Commas inside URLs only split a URL, never hide an http:// start. */
function srcsetUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(part => part.trim().split(/\s+/)[0] ?? "").filter(insecure);
}

/**
 * The subresources of an HTTPS page's HTML that load over HTTP: their number
 * and up to `limit` distinct examples. Comments, script bodies, templates and
 * <noscript> fallbacks are skipped (they load nothing as served).
 */
export function insecureResources(html: string, limit = 5): { count: number; samples: InsecureResource[] } {
  const styles: string[] = [];
  const source = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Keep the script tag (its src loads) but not its body (text, JSON, templates).
    .replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script\s*>/gi, (_m, attrs: string) => `<script${attrs}></script>`)
    .replace(/<(template|noscript|textarea|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css: string) => { styles.push(css); return " "; });

  const found: InsecureResource[] = [];
  const add = (kind: InsecureKind, url: string) => found.push({ kind, url: url.trim().slice(0, 500) });
  const css = (text: string) => {
    for (const m of text.matchAll(CSS_URL)) add("css", m[2]);
    for (const m of text.matchAll(CSS_IMPORT)) add("css", m[2]);
  };

  for (const m of source.matchAll(TAG)) {
    const name = m[1].toLowerCase();
    const tag = m[0];
    const hasStyle = /\sstyle\s*=/i.test(tag);
    const watched = ["script", "link", "img", "image", "source", "video", "audio", "track", "iframe", "frame", "embed", "object", "input", "form", "base"].includes(name);
    if (!watched && !hasStyle) continue;
    const attrs = parseAttrs(tag);
    if (hasStyle) css(attrs.get("style") ?? "");
    switch (name) {
      case "script":
        if (insecure(attrs.get("src"))) add("script", attrs.get("src")!);
        break;
      case "link": {
        const href = attrs.get("href");
        if (!insecure(href)) break;
        const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        let kind = rels.map(rel => LINK_FETCHES[rel]).find(Boolean);
        if (kind && (rels.includes("preload") || rels.includes("prefetch"))) kind = PRELOAD_AS[(attrs.get("as") ?? "").trim().toLowerCase()] ?? kind;
        if (kind) add(kind, href);
        break;
      }
      case "image": {
        // SVG <image href> (xlink:href in SVG 1.1); outside SVG the HTML parser reads <image src> as <img>.
        const url = ["href", "xlink:href", "src"].map(key => attrs.get(key)).find(insecure);
        if (url) add("image", url);
        break;
      }
      case "img":
        if (insecure(attrs.get("src"))) add("image", attrs.get("src")!);
        for (const url of srcsetUrls(attrs.get("srcset"))) add("image", url);
        break;
      case "source":
        if (insecure(attrs.get("src"))) add("media", attrs.get("src")!);
        for (const url of srcsetUrls(attrs.get("srcset"))) add("image", url);
        break;
      case "video":
        if (insecure(attrs.get("src"))) add("media", attrs.get("src")!);
        if (insecure(attrs.get("poster"))) add("image", attrs.get("poster")!);
        break;
      case "audio":
      case "track":
        if (insecure(attrs.get("src"))) add("media", attrs.get("src")!);
        break;
      case "iframe":
      case "frame":
        if (insecure(attrs.get("src"))) add("frame", attrs.get("src")!);
        break;
      case "embed":
        if (insecure(attrs.get("src"))) add("object", attrs.get("src")!);
        break;
      case "object":
        if (insecure(attrs.get("data"))) add("object", attrs.get("data")!);
        break;
      case "input":
        if ((attrs.get("type") ?? "").toLowerCase() === "image" && insecure(attrs.get("src"))) add("image", attrs.get("src")!);
        break;
      case "form":
        // Submitting over HTTP from an HTTPS page: browsers warn before sending.
        if (insecure(attrs.get("action"))) add("form", attrs.get("action")!);
        break;
      case "base":
        // Every relative URL on the page would resolve to HTTP.
        if (insecure(attrs.get("href"))) add("base", attrs.get("href")!);
        break;
    }
  }
  for (const text of styles) css(text);

  const seen = new Set<string>();
  const samples: InsecureResource[] = [];
  for (const item of found) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    if (samples.length < limit) samples.push(item);
  }
  return { count: seen.size, samples };
}
