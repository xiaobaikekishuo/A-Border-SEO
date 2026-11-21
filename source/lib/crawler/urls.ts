/*
 * URL helpers of the crawler, moved out of engine.ts unchanged so the
 * redirect and hreflang checks compare URLs exactly the way the crawl
 * normalizes them.
 */

/** Absolute http(s) URL without the fragment and without a trailing slash (except the root), or null. */
export function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Same host, ignoring a leading "www.". */
export function sameHost(a: string, b: string): boolean {
  try {
    return (
      new URL(a).hostname.replace(/^www\./, "") ===
      new URL(b).hostname.replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}

export function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}
