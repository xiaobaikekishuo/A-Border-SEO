/*
 * URLs of external sources an AI draft cites (lib/ai-workbench/trusted-sources.ts
 * stores them, lib/ai-workbench/link-review.ts checks drafts against them).
 */

// Click and campaign identifiers: two links to one page that differ only in these are the same source.
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|twclid|ttclid|igshid|mc_cid|mc_eid|_ga|_gl|spm)$/i;

/**
 * The stored form of a source URL, or null when it cannot be one: http(s)
 * only, no user or password, a dotted host, no fragment, no tracking
 * parameters, at most 2048 characters. "www.example.org/x" gets https.
 */
export function normalizeSourceUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(/^www\./i.test(value) ? `https://${value}` : value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname.includes(".")) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  if (![...url.searchParams.keys()].length) url.search = "";
  return url.href.length <= 2048 ? url.href : null;
}

/**
 * Spellings of one page compare equal: http or https, with or without "www.",
 * with or without a trailing slash. A port other than the scheme's default
 * makes a different page.
 */
export function sourceKey(normalized: string): string {
  const url = new URL(normalized);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
  return `${url.host.replace(/^www\./, "")}${path}${url.search}`;
}

/**
 * The verified page of this site a link points to, as `allowed` spells it,
 * or null. A link matches an allowed URL exactly, as a relative path, or in
 * a spelling sourceKey treats as the same page; a fragment or tracking
 * parameters do not change the page.
 */
export function verifiedPageMatcher(allowed: readonly string[], domain: string): (raw: string) => string | null {
  const exact = new Set(allowed);
  const byKey = new Map<string, string>();
  for (const url of allowed) {
    const normalized = normalizeSourceUrl(url);
    if (normalized && !byKey.has(sourceKey(normalized))) byKey.set(sourceKey(normalized), url);
  }
  const base = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return raw => {
    const value = raw.trim().replace(/^<|>$/g, "");
    if (!value || value.startsWith("#")) return null;
    if (exact.has(value)) return value;
    let url: URL;
    try { url = new URL(/^www\./i.test(value) ? `https://${value}` : value, base); } catch { return null; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    if (exact.has(url.href)) return url.href;
    const normalized = normalizeSourceUrl(url.href);
    return normalized ? byKey.get(sourceKey(normalized)) ?? null : null;
  };
}

/** The host without "www.", for short markers; "" when the value is not a URL. */
export function hostOf(value: string): string {
  try { return new URL(/^www\./i.test(value) ? `https://${value}` : value).hostname.replace(/^www\./, ""); } catch { return ""; }
}
