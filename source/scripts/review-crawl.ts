/** Local, explicit historical review. No network requests or new crawl jobs. */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  AUDIT_POLICY_VERSION, AUDIT_EXCLUDED_KIND, classifyAuditIssues,
  computeAuditHealthScore, computePageShareHealthScore, HEALTH_SCORE_VERSION, originalAuditIssue, type AuditPolicyIssue, type VerifiedInboundLink,
} from "../lib/crawler/audit-policy";

const args = process.argv.slice(2);
const allowed = new Set(["--crawl-id", "--domain", "--verified-links-file", "--apply", "--restore"]);
function value(flag: string) { const n = args.indexOf(flag); return n < 0 ? undefined : args[n + 1]; }
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : JSON.parse(JSON.stringify(value));
}
const internal = new Set(["crawl_summary", "content_score", AUDIT_EXCLUDED_KIND]);
function visible(issue: AuditPolicyIssue) { return !internal.has(String(obj(issue.details).kind)); }

async function main() {
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (!["--apply", "--restore"].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value: ${args[i]}`);
      i++;
    }
  }
  const crawlId = value("--crawl-id"), expectedDomain = value("--domain");
  if (!crawlId || !expectedDomain) throw new Error("Require --crawl-id and --domain; default is dry run. Add --apply to commit or --restore --apply to undo this review.");
  const restore = args.includes("--restore"), apply = args.includes("--apply");
  const evidenceFile = value("--verified-links-file");
  const links: VerifiedInboundLink[] = evidenceFile ? JSON.parse(readFileSync(evidenceFile, "utf8")) : [];
  if (!Array.isArray(links)) throw new Error("Verified links must be a JSON array.");
  const db = new PrismaClient();
  try {
    const crawl = await db.crawl.findUnique({ where: { id: crawlId }, include: { site: { select: { domain: true } } } });
    if (!crawl || crawl.site.domain !== expectedDomain || crawl.status !== "COMPLETED") throw new Error("Crawl must exist, match the explicit domain, and be COMPLETED.");
    const [pages, raw] = await Promise.all([
      db.auditPage.findMany({ where: { crawlId }, select: { url: true, statusCode: true, indexable: true, canonical: true, contentHash: true, title: true, description: true } }),
      db.crawlIssue.findMany({ where: { crawlId }, orderBy: { id: "asc" } }),
    ]);
    const issues = raw.map(row => ({ ...row, details: row.details as Record<string, unknown> | null }));
    if (pages.length !== crawl.pagesFound) throw new Error("Incomplete stored AuditPage snapshot; refusing reclassification.");
    const summary = issues.find(row => obj(row.details).kind === "crawl_summary");
    if (!summary) throw new Error("Missing crawl summary; refusing to review without a reversible baseline.");
    const summaryDetails = obj(summary.details);
    const previous = obj(summaryDetails.localAuditReview);
    const existingBaseline = previous.version === AUDIT_POLICY_VERSION;
    if (!existingBaseline && issues.some(row => obj(obj(row.details).auditPolicy).version === AUDIT_POLICY_VERSION && obj(row.details).kind !== "crawl_summary")) {
      throw new Error("This crawl already contains policy classifications without a historical review baseline; refusing a non-reversible review.");
    }
    if (restore && !existingBaseline) throw new Error("No matching local review to restore.");
    const baselineSummary = existingBaseline ? obj(previous.originalSummary) : structuredClone(summaryDetails);
    const baselineCrawl = existingBaseline ? obj(previous.originalCrawl) : { issuesFound: crawl.issuesFound, healthScore: crawl.healthScore };
    const incomplete = crawl.pagesFound >= crawl.maxPages || obj(summaryDetails.auditPolicy).incomplete === true;
    const reviewed = restore ? issues.map(originalAuditIssue) : classifyAuditIssues(issues, pages, { incomplete, verifiedInboundLinks: links });
    const assessed = reviewed.filter(visible);
    const excluded = reviewed.filter(row => obj(row.details).kind === AUDIT_EXCLUDED_KIND);
    const excludedReasons: Record<string, number> = {};
    for (const row of excluded) {
      const reason = String(obj(obj(row.details).auditPolicy).reason);
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    }
    // Re-score with the formula the crawl was saved with, so a review never mixes the two scales.
    // The page-share score counts the audited pages only (noindex pages raise no issues), like the crawl itself.
    const auditedPages = pages.filter(page => page.indexable || page.statusCode >= 400).length;
    const healthScore = restore ? baselineCrawl.healthScore as number | null
      : crawl.healthScoreVersion === HEALTH_SCORE_VERSION ? computePageShareHealthScore(reviewed, auditedPages, crawl.pagesFound)
      : computeAuditHealthScore(reviewed, crawl.pagesFound);
    const issuesFound = restore ? Number(baselineCrawl.issuesFound) : assessed.length;
    const originalOrphans = Number(baselineSummary.orphans ?? 0);
    const nextSummary = restore ? baselineSummary : {
      ...baselineSummary,
      orphans: Math.max(0, originalOrphans - (excludedReasons.verified_inbound_link ?? 0)),
      auditPolicy: { ...obj(baselineSummary.auditPolicy), version: AUDIT_POLICY_VERSION, incomplete },
      localAuditReview: {
        version: AUDIT_POLICY_VERSION, reviewedAt: new Date().toISOString(),
        originalCrawl: baselineCrawl, originalSummary: baselineSummary,
        excluded: excluded.length, excludedReasons, evidence: links,
        note: "Supplemental public links describe review-time observations, not historical crawl-time HTML. AuditPage and AuditLink snapshots are unchanged.",
      },
    };
    const changes = reviewed.filter(row => row.id !== summary.id && !isDeepStrictEqual(row, issues.find(before => before.id === row.id)));
    const result = {
      mode: apply ? (restore ? "restore" : "apply") : (restore ? "restore-dry-run" : "dry-run"),
      version: AUDIT_POLICY_VERSION, crawlId, domain: expectedDomain,
      sample: { pages: pages.length, maxPages: crawl.maxPages, incomplete },
      before: { issuesFound: crawl.issuesFound, healthScore: crawl.healthScore },
      after: { issuesFound, healthScore, excluded: excluded.length, excludedReasons },
      changedIssueRows: changes.length, rawIssueRowsRetained: raw.length, verifiedLinks: links,
      remainingIssues: assessed.map(({ type, severity, url, message }) => ({ type, severity, url, message })),
    };
    if (apply) {
      await db.$transaction(async tx => {
        const current = await tx.crawl.findUnique({ where: { id: crawlId } });
        if (!current || current.status !== "COMPLETED" || current.issuesFound !== crawl.issuesFound || current.healthScore !== crawl.healthScore) throw new Error("Crawl changed during review; rerun dry run.");
        for (const row of changes) await tx.crawlIssue.update({ where: { id: row.id }, data: { severity: row.severity, message: row.message, details: json(row.details) } });
        await tx.crawlIssue.update({ where: { id: summary.id }, data: { details: json(nextSummary) } });
        await tx.crawl.update({ where: { id: crawlId }, data: { issuesFound, healthScore } });
      }, { timeout: 30_000 });
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally { await db.$disconnect(); }
}
main().catch(error => { process.stderr.write(String(error instanceof Error ? error.message : error) + "\n"); process.exitCode = 1; });
