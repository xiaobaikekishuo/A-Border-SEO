/** Conservative review of stored findings. Raw findings remain recoverable. */
export const AUDIT_POLICY_VERSION = "canonical-audit-v1";
export const AUDIT_EXCLUDED_KIND = "audit_excluded";

export type AuditPolicyPage = {
  url: string;
  statusCode: number;
  indexable: boolean;
  canonical: string | null;
  contentHash: string | null;
  title: string | null;
  description: string | null;
};
export type AuditPolicyIssue = {
  url: string;
  type: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  message: string;
  details?: Record<string, unknown> | null;
};
export type VerifiedInboundLink = {
  sourceUrl: string;
  targetUrl: string;
  sourceStatus: number;
  verifiedAt: string;
};
export type AuditPolicyOptions = {
  incomplete: boolean;
  verifiedInboundLinks?: VerifiedInboundLink[];
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function normalize(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

/** Re-review the original observation, never stack policy metadata on itself. */
export function originalAuditIssue<T extends AuditPolicyIssue>(issue: T): T {
  const copy = structuredClone(issue);
  const policy = object(object(copy.details).auditPolicy);
  if (policy.version !== AUDIT_POLICY_VERSION) return copy;
  const original = object(policy.original);
  if (!["CRITICAL", "WARNING", "INFO"].includes(String(original.severity)) || typeof original.message !== "string") return copy;
  return { ...copy, severity: original.severity, message: original.message,
    details: structuredClone(original.details) } as T;
}

export function classifyAuditIssues<T extends AuditPolicyIssue>(
  input: readonly T[], pages: readonly AuditPolicyPage[], options: AuditPolicyOptions,
): T[] {
  const byUrl = new Map<string, AuditPolicyPage>();
  for (const page of pages) {
    const url = normalize(page.url);
    if (url) byUrl.set(url, page);
  }
  const identities = new Map<string, string>();
  for (const [url, page] of byUrl) {
    identities.set(url, url);
    if (page.statusCode !== 200 || !page.indexable || !page.canonical || !page.contentHash) continue;
    const canonical = normalize(page.canonical, url);
    if (!canonical || canonical === url || !sameOrigin(url, canonical)) continue;
    const target = byUrl.get(canonical);
    if (!target || target.statusCode !== 200 || !target.indexable) continue;
    if (target.canonical && normalize(target.canonical, canonical) !== canonical) continue;
    // A canonical hint alone cannot hide a different page or an invalid target.
    if (!/^[a-f0-9]{64}$/i.test(page.contentHash) || page.contentHash !== target.contentHash) continue;
    identities.set(url, canonical);
  }
  const groups = { title: new Map<string, Set<string>>(), description: new Map<string, Set<string>>() };
  for (const [url, page] of byUrl) {
    if (!page.indexable && page.statusCode < 400) continue;
    for (const field of ["title", "description"] as const) {
      const value = page[field];
      if (!value) continue;
      const group = groups[field].get(value) ?? new Set<string>();
      group.add(identities.get(url) ?? url);
      groups[field].set(value, group);
    }
  }

  return input.map((row) => {
    const issue = originalAuditIssue(row);
    const details = object(issue.details);
    const mark = (disposition: "excluded" | "unverified", reason: string, evidence: Record<string, unknown>, message: string): T => ({
      ...issue,
      ...(disposition === "unverified" ? { severity: "INFO" as const } : {}),
      message,
      details: {
        ...details,
        ...(disposition === "excluded" ? { kind: AUDIT_EXCLUDED_KIND } : {}),
        auditPolicy: {
          version: AUDIT_POLICY_VERSION, disposition, reason, ...evidence,
          original: { severity: issue.severity, message: issue.message, details: issue.details ?? null },
        },
      },
    });
    const url = normalize(issue.url);
    if (!url) return issue;
    const identity = identities.get(url) ?? url;
    const page = byUrl.get(url);
    const field = issue.type === "DUPLICATE_TITLE" ? "title" : issue.type === "DUPLICATE_DESCRIPTION" ? "description" : null;
    if (field && page?.[field]) {
      const group = groups[field].get(page[field]);
      // Retain duplicates across distinct canonical pages. Count a confirmed alias only once.
      if (group && (identity !== url || (group.size === 1 && [...identities].some(([u, id]) => u !== id && id === identity)))) {
        return mark("excluded", "identical_canonical_alias", { canonical: identity },
          "Identical content is already consolidated to a verified canonical page; original duplicate finding retained.");
      }
    }
    const sitemapOmission = issue.type === "MISSING_SITEMAP" && issue.severity === "INFO" &&
      (details.kind === "not_in_sitemap" || issue.message === "Crawled page not listed in sitemap");
    if (sitemapOmission && identity !== url) {
      return mark("excluded", "canonical_alias_sitemap", { canonical: identity },
        "Identical canonical alias need not be listed separately in the sitemap; target coverage is evaluated separately.");
    }
    if (details.kind === "orphan") {
      const link = options.verifiedInboundLinks?.find((candidate) => {
        const source = normalize(candidate.sourceUrl);
        const target = normalize(candidate.targetUrl);
        return candidate.sourceStatus === 200 && source && target === url && source !== url &&
          sameOrigin(source, url) && Number.isFinite(Date.parse(candidate.verifiedAt));
      });
      if (link) {
        return mark("excluded", "verified_inbound_link", { inboundLink: { ...link } },
          "A public HTML inbound link was verified during review; original sampled-crawl observation retained.");
      }
      if (options.incomplete) {
        return mark("unverified", "incomplete_link_graph", {},
          "Potential orphan in a limited crawl; inbound links outside the sample are unverified. Not deducted from health.");
      }
    }
    return issue;
  });
}

/** Findings the health score never counts: internal rows, policy exclusions and unverified candidates. */
function scoredIssue(issue: AuditPolicyIssue): boolean {
  const details = object(issue.details);
  if (["crawl_summary", "content_score", AUDIT_EXCLUDED_KIND].includes(String(details.kind))) return false;
  return object(details.auditPolicy).disposition !== "unverified";
}

/**
 * Health score version stored with each new crawl (Crawl.healthScoreVersion).
 * Crawls without a version were scored with the legacy per-finding deduction.
 */
export const HEALTH_SCORE_VERSION = "page-share-v1";
/** Most a single issue type can take off when it affects every crawled page. */
export const HEALTH_TYPE_WEIGHTS = { CRITICAL: 30, WARNING: 12, INFO: 3 } as const;
const SEVERITY_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;

/** Site-wide findings (no robots.txt, no sitemap) describe the whole site, not one page. */
function siteWide(issue: AuditPolicyIssue): boolean {
  if (issue.type === "MISSING_ROBOTS") return true;
  return issue.type === "MISSING_SITEMAP" && object(issue.details).kind !== "not_in_sitemap";
}

/**
 * Share-of-affected-pages health score. Each issue type takes off at most its
 * severity weight, scaled by the square root of the share of audited pages it
 * affects, so a problem on a few pages still shows while hundreds of findings
 * of one kind cannot push a large site to zero on their own. A type's
 * severity is its most severe finding; a site-wide finding affects the whole
 * site.
 *
 * `auditedPages` is the number of pages whose findings count (isAudited in
 * engine.ts): a noindex page is crawled but raises no issues, so counting it
 * would shrink every share and raise the score. `crawledPages` only tells an
 * empty crawl (score 0) from one whose pages are all noindex.
 */
export function computePageShareHealthScore(issues: readonly AuditPolicyIssue[], auditedPages: number, crawledPages: number = auditedPages): number {
  if (crawledPages <= 0) return 0;
  const pagesFound = Math.max(1, auditedPages);
  const groups = new Map<string, { severity: AuditPolicyIssue["severity"]; urls: Set<string>; site: boolean }>();
  for (const issue of issues) {
    if (!scoredIssue(issue)) continue;
    const site = siteWide(issue);
    const key = auditIssueDisplayType(issue) + (site ? ":site" : "");
    const group = groups.get(key) ?? { severity: issue.severity, urls: new Set<string>(), site };
    if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[group.severity]) group.severity = issue.severity;
    group.urls.add(normalize(issue.url) ?? issue.url);
    groups.set(key, group);
  }
  let deduction = 0;
  for (const group of groups.values()) {
    const share = group.site ? 1 : Math.min(1, group.urls.size / pagesFound);
    deduction += HEALTH_TYPE_WEIGHTS[group.severity] * Math.sqrt(share);
  }
  return Math.max(0, Math.min(100, Math.round(100 - deduction)));
}

/**
 * Legacy formula (100 minus 8/3/1 per finding), kept for crawls saved before
 * HEALTH_SCORE_VERSION and for re-reviewing them.
 */
export function computeAuditHealthScore(issues: readonly AuditPolicyIssue[], pagesFound: number): number {
  if (pagesFound === 0) return 0;
  let score = 100;
  for (const issue of issues) {
    if (!scoredIssue(issue)) continue;
    score -= issue.severity === "CRITICAL" ? 8 : issue.severity === "WARNING" ? 3 : 1;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function auditIssueDisplayType(issue: Pick<AuditPolicyIssue, "type" | "details">): string {
  const kind = object(issue.details).kind;
  if (kind === "orphan") return "ORPHAN_CANDIDATE";
  if (kind === "not_in_sitemap") return "SITEMAP_COVERAGE";
  return issue.type;
}
