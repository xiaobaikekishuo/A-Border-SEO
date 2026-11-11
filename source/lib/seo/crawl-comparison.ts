import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ContentError } from "@/lib/content-planner/http";
import { visibleIssuesWhere } from "@/lib/crawler/issue-filter";
import { AUDIT_EXCLUDED_KIND } from "@/lib/crawler/audit-policy";
import { STRUCTURED_DATA_VERSIONS } from "@/lib/seo/structured-data";

export const COMPARISON_PAGE_LIMIT = 300;
export const COMPARISON_CRAWL_LIMIT = 20;
const requestSchema = z.object({ beforeId: z.string().min(1).max(100).optional(), afterId: z.string().min(1).max(100).optional() }).strict()
  .refine(value => !!value.beforeId === !!value.afterId, "Choose both crawls");
const crawlSelect = { id: true, finishedAt: true, pagesFound: true, maxPages: true, _count: { select: { auditPages: true } } } satisfies Prisma.CrawlSelect;
const pageSelect = { url: true, title: true, description: true, canonical: true, statusCode: true, indexable: true, robotsMeta: true, xRobotsTag: true, noindexSource: true, schemaReport: true } satisfies Prisma.AuditPageSelect;
type StoredPage = Prisma.AuditPageGetPayload<{ select: typeof pageSelect }>;
type StoredCrawl = Prisma.CrawlGetPayload<{ select: typeof crawlSelect }>;
type Db = Pick<PrismaClient, "site" | "crawl" | "auditPage" | "crawlIssue">;
export type CrawlChoice = { id: string; finishedAt: string; storedPages: number; pageLimit: number; sampleLimited: boolean };
export type SchemaSummary = { state: "UNKNOWN" | "CHECKED" | "PARTIAL"; blocks: number | null; parsed: number | null; types: string[]; findings: string[]; detailsLimited: boolean };
export type ComparisonField = "title" | "description" | "canonical" | "statusCode" | "indexable" | "robotsMeta" | "xRobotsTag" | "noindexSource" | "schema";
export type PageDifference = {
  url: string; status: "CHANGED" | "UNCHANGED" | "ONLY_BEFORE" | "ONLY_AFTER" | "AMBIGUOUS";
  changes: { field: ComparisonField; before: string | number | boolean | null; after: string | number | boolean | null; previewTruncated: boolean }[];
  schema: { before: SchemaSummary | null; after: SchemaSummary | null; comparison: "CHANGED" | "SAME" | "UNKNOWN" };
};
export type IssueSnapshot = { visible: number; unverified: number; excluded: number };
export type CrawlComparisonResponse = { siteId: string; crawls: CrawlChoice[]; crawlListLimit: number; comparison: null | {
  before: CrawlChoice & { loadedPages: number; truncated: boolean; issues: IssueSnapshot };
  after: CrawlChoice & { loadedPages: number; truncated: boolean; issues: IssueSnapshot };
  pageLimit: number; totals: Record<PageDifference["status"], number>; rows: PageDifference[];
} };

const asObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function summarizeSchema(raw: unknown): SchemaSummary {
  const value = asObject(raw);
  if (!STRUCTURED_DATA_VERSIONS.includes(value.version as number) || !Array.isArray(value.findings) || !Array.isArray(value.entities)) return { state: "UNKNOWN", blocks: null, parsed: null, types: [], findings: [], detailsLimited: false };
  const types = [...new Set(value.entities.flatMap(entity => { const types = asObject(entity).types; return Array.isArray(types) ? types.filter((type): type is string => typeof type === "string").map(type => type.slice(0, 100)) : []; }))].sort();
  const findings = value.findings.map(finding => { const item = asObject(finding); return [item.severity, item.code, item.path].map(part => String(part ?? "").slice(0, 200)).join(" · "); }).sort();
  return { state: value.coverage === "COMPLETE" && !value.truncated ? "CHECKED" : "PARTIAL", blocks: typeof value.jsonLdBlocks === "number" ? value.jsonLdBlocks : null, parsed: typeof value.parsedBlocks === "number" ? value.parsedBlocks : null, types: types.slice(0, 20), findings: findings.slice(0, 60), detailsLimited: types.length > 20 || findings.length > 60 };
}
const fields = ["title", "description", "canonical", "statusCode", "indexable", "robotsMeta", "xRobotsTag", "noindexSource"] as const;
const preview = (value: string | number | boolean | null) => typeof value === "string" ? value.slice(0, 1000) : value;

/** Pair exact observed URL strings. Scheme, www, slash, query order and fragments are not assumed equivalent. */
export function compareSavedPages(before: StoredPage[], after: StoredPage[]): PageDifference[] {
  const group = (rows: StoredPage[]) => { const map = new Map<string, StoredPage[]>(); for (const row of rows) map.set(row.url, [...(map.get(row.url) ?? []), row]); return map; };
  const left = group(before), right = group(after);
  return [...new Set([...left.keys(), ...right.keys()])].sort().map<PageDifference>(url => {
    const oldRows = left.get(url) ?? [], newRows = right.get(url) ?? [];
    const old = oldRows[0], next = newRows[0];
    const schema = { before: old ? summarizeSchema(old.schemaReport) : null, after: next ? summarizeSchema(next.schemaReport) : null, comparison: "UNKNOWN" as "CHANGED" | "SAME" | "UNKNOWN" };
    if (oldRows.length > 1 || newRows.length > 1) return { url, status: "AMBIGUOUS", changes: [], schema: { before: null, after: null, comparison: "UNKNOWN" } };
    if (!old || !next) return { url, status: old ? "ONLY_BEFORE" : "ONLY_AFTER", changes: [], schema };
    const changes: PageDifference["changes"] = fields.filter(field => old[field] !== next[field]).map(field => ({ field, before: preview(old[field]), after: preview(next[field]), previewTruncated: [old[field], next[field]].some(value => typeof value === "string" && value.length > 1000) }));
    // Unknown or partial checks cannot establish that a finding disappeared.
    if (schema.before?.state === "CHECKED" && schema.after?.state === "CHECKED" && !schema.before.detailsLimited && !schema.after.detailsLimited) {
      schema.comparison = JSON.stringify(schema.before) === JSON.stringify(schema.after) ? "SAME" : "CHANGED";
    }
    return { url, status: changes.length || schema.comparison === "CHANGED" ? "CHANGED" : "UNCHANGED", changes, schema };
  });
}
function choice(crawl: StoredCrawl): CrawlChoice {
  return { id: crawl.id, finishedAt: crawl.finishedAt!.toISOString(), storedPages: crawl._count.auditPages, pageLimit: crawl.maxPages, sampleLimited: crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages };
}
async function issueSnapshot(db: Db, crawlId: string): Promise<IssueSnapshot> {
  const where = visibleIssuesWhere(crawlId);
  const [visible, unverified, excluded] = await Promise.all([
    db.crawlIssue.count({ where }),
    db.crawlIssue.count({ where: { ...where, details: { path: ["auditPolicy", "disposition"], equals: "unverified" } } }),
    db.crawlIssue.count({ where: { crawlId, details: { path: ["kind"], equals: AUDIT_EXCLUDED_KIND } } }),
  ]);
  return { visible, unverified, excluded };
}
export async function getCrawlComparison(db: Db, userId: string | null | undefined, siteId: string, raw: unknown): Promise<CrawlComparisonResponse> {
  if (!userId) throw new ContentError("Unauthorized", 401);
  if (!await db.site.findFirst({ where: { id: siteId, userId }, select: { id: true } })) throw new ContentError("Not found", 404);
  const request = requestSchema.parse(raw);
  const where = { siteId, status: "COMPLETED" as const, finishedAt: { not: null } };
  const crawls = await db.crawl.findMany({ where, orderBy: [{ finishedAt: "desc" }, { id: "asc" }], take: COMPARISON_CRAWL_LIMIT, select: crawlSelect });
  const base = { siteId, crawls: crawls.map(choice), crawlListLimit: COMPARISON_CRAWL_LIMIT };
  if (!request.beforeId || !request.afterId) return { ...base, comparison: null };
  if (request.beforeId === request.afterId) throw new ContentError("Choose two different completed crawls", 400);
  const selected = await db.crawl.findMany({ where: { ...where, id: { in: [request.beforeId, request.afterId] } }, select: crawlSelect, take: 2 });
  const before = selected.find(crawl => crawl.id === request.beforeId), after = selected.find(crawl => crawl.id === request.afterId);
  if (!before || !after) throw new ContentError("Completed crawl not found in this site", 404);
  if (before.finishedAt!.getTime() >= after.finishedAt!.getTime()) throw new ContentError("Before must be older than after", 400);
  const [oldPages, newPages, oldIssues, newIssues] = await Promise.all([
    db.auditPage.findMany({ where: { crawlId: before.id }, orderBy: [{ url: "asc" }, { id: "asc" }], take: COMPARISON_PAGE_LIMIT, select: pageSelect }),
    db.auditPage.findMany({ where: { crawlId: after.id }, orderBy: [{ url: "asc" }, { id: "asc" }], take: COMPARISON_PAGE_LIMIT, select: pageSelect }),
    issueSnapshot(db, before.id), issueSnapshot(db, after.id),
  ]);
  const rows = compareSavedPages(oldPages, newPages);
  const totals: Record<PageDifference["status"], number> = { CHANGED: 0, UNCHANGED: 0, ONLY_BEFORE: 0, ONLY_AFTER: 0, AMBIGUOUS: 0 };
  for (const row of rows) totals[row.status]++;
  return { ...base, comparison: { before: { ...choice(before), loadedPages: oldPages.length, truncated: before._count.auditPages > oldPages.length, issues: oldIssues }, after: { ...choice(after), loadedPages: newPages.length, truncated: after._count.auditPages > newPages.length, issues: newIssues }, pageLimit: COMPARISON_PAGE_LIMIT, totals, rows } };
}
