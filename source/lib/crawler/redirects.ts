import { normalizeUrl, sameHost } from "./urls";

/*
 * Redirect findings (IssueType REDIRECT). The crawler follows redirects
 * itself (fetchPublic in engine.ts) and keeps every hop; after the crawl,
 * each requested URL that redirected is reported when
 *
 *   chain           it takes two or more hops to reach the final URL
 *   sitemap         the sitemap lists it instead of the final URL
 *   internal_links  pages of the site still link to it
 *
 * A single redirect nothing links to (the bare domain to www, say) is not
 * reported. The crawler drops trailing slashes when it normalizes URLs, so a
 * hop that only adds or removes the trailing slash may be its own doing; such
 * hops are ignored rather than blamed on the site.
 */

export type RedirectHop = { url: string; status: number; location: string };
export type RedirectRecord = {
  /** The URL requested, normalized as links and the sitemap are. */
  url: string;
  /** Where the redirects ended, normalized. */
  finalUrl: string;
  finalStatus: number;
  hops: RedirectHop[];
};
export type RedirectProblem = "chain" | "sitemap" | "internal_links" | "temporary";
export type RedirectIssue = {
  url: string;
  type: "REDIRECT";
  severity: "WARNING" | "INFO";
  message: string;
  details: Record<string, unknown>;
};

const TEMPORARY = new Set([302, 303, 307]);

/** Hops that change the URL beyond what the crawler's own normalization changes. */
export function effectiveRedirectHops(hops: readonly RedirectHop[]): RedirectHop[] {
  return hops.filter(hop => {
    const from = normalizeUrl(hop.url, hop.url);
    const to = normalizeUrl(hop.location, hop.url);
    return !!to && from !== to;
  });
}

export function redirectMessage(kind: Exclude<RedirectProblem, "temporary">, record: { finalUrl: string }, hops: readonly RedirectHop[], inlinks: number): string {
  if (kind === "chain") return `Redirect chain: ${hops.length} hops to ${record.finalUrl}`;
  if (kind === "sitemap") return `Sitemap lists a redirecting URL (${hops[0].status}) → ${record.finalUrl}`;
  return inlinks === 1
    ? `1 internal link points to a redirect (${hops[0].status}) → ${record.finalUrl}`
    : `${inlinks} internal links point to a redirect (${hops[0].status}) → ${record.finalUrl}`;
}

export function redirectIssues(input: {
  records: readonly RedirectRecord[];
  /** Links found on crawled pages; targets are normalized. */
  links: readonly { sourceUrl: string; targetUrl: string; isInternal: boolean }[];
  sitemapUrls: readonly string[];
  seedUrl: string;
  howToFix?: string;
}): RedirectIssue[] {
  const inlinks = new Map<string, Set<string>>();
  for (const link of input.links) {
    if (!link.isInternal || link.sourceUrl === link.targetUrl) continue;
    const sources = inlinks.get(link.targetUrl) ?? new Set<string>();
    sources.add(link.sourceUrl);
    inlinks.set(link.targetUrl, sources);
  }
  const sitemap = new Set(input.sitemapUrls);
  const seen = new Set<string>();
  const out: RedirectIssue[] = [];
  for (const record of input.records) {
    if (seen.has(record.url)) continue;
    seen.add(record.url);
    const hops = effectiveRedirectHops(record.hops);
    if (!hops.length) continue;
    const sources = [...(inlinks.get(record.url) ?? [])];
    const chain = hops.length >= 2;
    const inSitemap = sitemap.has(record.url);
    if (!chain && !inSitemap && !sources.length) continue;
    const temporary = hops.some(hop => TEMPORARY.has(hop.status));
    const offsite = !sameHost(record.finalUrl, input.seedUrl);
    const problems: RedirectProblem[] = [];
    if (chain) problems.push("chain");
    if (inSitemap) problems.push("sitemap");
    if (sources.length) problems.push("internal_links");
    if (temporary) problems.push("temporary");
    const kind = problems[0] as Exclude<RedirectProblem, "temporary">;
    out.push({
      url: record.url,
      type: "REDIRECT",
      // A redirect to another site (an affiliate or partner link) is often intended.
      severity: !offsite && (chain || inSitemap) ? "WARNING" : "INFO",
      message: redirectMessage(kind, record, hops, sources.length),
      details: {
        kind,
        problems,
        hops: hops.map(hop => ({ url: hop.url, status: hop.status, location: hop.location })),
        finalUrl: record.finalUrl,
        finalStatus: record.finalStatus,
        inlinks: sources.length,
        inlinkSamples: sources.slice(0, 5),
        inSitemap,
        temporary,
        offsite,
        ...(input.howToFix ? { howToFix: input.howToFix } : {}),
      },
    });
  }
  return out;
}
