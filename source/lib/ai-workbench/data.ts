import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { ownedSite, WORKER_ONLINE_MS, QUEUE_TIMEOUT_MS, RUN_TIMEOUT_MS } from "@/lib/content-planner/data";
import { briefSchema, siteUrl } from "@/lib/content-planner/schema";
import { articleSearchEvidence } from "@/lib/content-planner/article-search-evidence";
import { assertPlanConnection } from "@/lib/chatgpt-connection/service";
import { visibleIssuesWhere } from "@/lib/crawler/issue-filter";
import { auditIssueDisplayType } from "@/lib/crawler/audit-policy";
import { collectDiagnosticEvidence } from "./diagnostic";
import { assertKeywordRequest, buildKeywordContext } from "./keyword-research";
import { assertResearchRequest, buildResearchContext, isResearchAnalysis, type ResearchEvidence, type ResearchKind } from "./research-analysis";
import type { DiagnosticEvidence } from "./diagnostic-types";
import { workbenchActionSchema, workbenchRequestSchema, workbenchResultSchema, type WorkbenchRequest, type WorkbenchWorkspace } from "./schema";

export type WorkbenchDb = PrismaClient;
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => value as Prisma.InputJsonValue;
export const CANCEL_MESSAGE = "Canceled by user. The local helper stops at its next heartbeat; already used quota is not refunded.";
export function expireWorkbenchJobs(db: WorkbenchDb | Tx, now: Date, siteId?: string) {
  return db.aiWorkbenchJob.updateMany({ where: { ...(siteId ? { siteId } : {}), OR: [
    { status: "QUEUED", createdAt: { lte: new Date(now.getTime() - QUEUE_TIMEOUT_MS) } },
    { status: "RUNNING", OR: [{ leaseExpiresAt: { lte: now } }, { leaseExpiresAt: null }, { startedAt: { lte: new Date(now.getTime() - RUN_TIMEOUT_MS) } }] },
  ] }, data: { status: "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null, finishedAt: now,
    error: "The local workbench job timed out. No website changes were made. Start a new task when the account worker is online." } });
}
function sameSiteUrl(url: string | null | undefined, domain: string) {
  try { return siteUrl(url, domain); } catch { return null; }
}
function unverified(details: unknown) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const policy = (details as Record<string, unknown>).auditPolicy;
  return !!policy && typeof policy === "object" && !Array.isArray(policy) && (policy as Record<string, unknown>).disposition === "unverified";
}
function diagnosticSnapshot(diagnostic: DiagnosticEvidence) {
  const { pages: _pages, page, ...rest } = diagnostic;
  const { body: _body, ...pageFacts } = page ?? { body: "" };
  const report = rest.schemaReport;
  const shortened = !!report && (report.findings.length > 20 || report.entities.length > 10);
  return { ...rest, schemaReport: shortened ? { ...report, findings: report.findings.slice(0, 20), entities: report.entities.slice(0, 10), coverage: "PARTIAL" as const, truncated: true,
    limitations: [...report.limitations, `Task snapshot includes ${Math.min(20, report.findings.length)} of ${report.findings.length} findings and ${Math.min(10, report.entities.length)} of ${report.entities.length} entities.`] } : report,
    page: page ? pageFacts as Omit<NonNullable<DiagnosticEvidence["page"]>, "body"> : null };
}
async function buildContext(tx: Tx, site: { id: string; domain: string }, input: WorkbenchRequest, now = new Date()) {
  if (isResearchAnalysis(input.kind)) return buildResearchContext(tx, site, input, now);
  if (input.kind === "KEYWORD_RESEARCH") return buildKeywordContext(tx, site, input);
  if (input.pageId && input.diagnosis?.pageId && input.pageId !== input.diagnosis.pageId) throw new ContentError("Selected page does not match the diagnosis", 400);
  const diagnostic = input.diagnosis || input.pageId ? await collectDiagnosticEvidence(tx, site, { ...input.diagnosis, ...(input.pageId ? { pageId: input.pageId } : {}) }) : null;
  if (input.diagnosis && !diagnostic?.selection.url) throw new ContentError("Choose a page from the saved evidence before starting a task", 400);
  const pageId = diagnostic?.page?.id ?? input.pageId;
  const crawl = await tx.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true, pagesFound: true, maxPages: true } });
  const page = pageId ? await tx.auditPage.findFirst({ where: { id: pageId, crawlId: crawl?.id ?? "__no_completed_crawl__", crawl: { siteId: site.id } },
    select: { id: true, url: true, title: true, description: true, statusCode: true, canonical: true, indexable: true, articleText: true, articleHeadings: true } }) : null;
  if (pageId && !page) throw new ContentError("Page not found in this site's latest completed crawl", 404);
  const cluster = input.clusterId ? await tx.contentCluster.findFirst({ where: { id: input.clusterId, siteId: site.id },
    select: { title: true, keyword: true, funnel: true, intent: true, url: true, brief: true, pillar: { select: { title: true, description: true } } } }) : null;
  if (input.clusterId && !cluster) throw new ContentError("Topic not found", 404);
  const body = input.body || page?.articleText?.slice(0, 12000) || "";
  if (input.kind === "REWRITE_ARTICLE" && body.trim().length < 100) throw new ContentError("Article body is missing or too short. Paste at least 100 characters or choose a page with captured body text.");
  const candidates = crawl ? await tx.auditPage.findMany({ where: { crawlId: crawl.id, statusCode: 200, indexable: true }, orderBy: { url: "asc" }, take: 40, select: { url: true, title: true } }) : [];
  const knownPages = candidates.flatMap(item => { const url = sameSiteUrl(item.url, site.domain); return url && url.length <= 2048 ? [{ url, title: item.title?.slice(0, 300) ?? null }] : []; });
  for (const item of [page, cluster, diagnostic?.selection.url ? { url: diagnostic.selection.url, title: null } : null]) {
    const url = sameSiteUrl(item?.url, site.domain);
    if (url && url.length <= 2048 && !knownPages.some(p => p.url === url)) knownPages.push({ url, title: item?.title?.slice(0, 300) ?? null });
  }
  const issues = crawl ? await tx.crawlIssue.findMany({ where: { ...visibleIssuesWhere(crawl.id), ...(page || diagnostic?.selection.url ? { url: page?.url ?? diagnostic!.selection.url } : {}) }, orderBy: { id: "asc" }, take: 30,
    select: { url: true, type: true, severity: true, message: true, details: true } }) : [];
  const evidenceUrls = [...new Set([page?.url, cluster?.url, diagnostic?.selection.url].filter((url): url is string => !!url))];
  const searchEvidence = await articleSearchEvidence(tx, site.id, evidenceUrls.length ? evidenceUrls : knownPages.slice(0, 8).map(p => p.url));
  const brief = briefSchema.safeParse(cluster?.brief);
  const context = { domain: site.domain, body, bodySource: input.body ? "PASTED" : body ? "CRAWL" : "NONE",
    bodyEvidence: { source: input.body ? "PASTED" : body ? "CRAWL" : "NONE", characters: body.length, characterLimit: input.body ? 24000 : 12000, isExcerpt: !input.body && !!body, completeness: "UNKNOWN" },
    evidenceLimits: { queryCandidates: 50, auditIssues: 30, knownPages: 40, headings: 30, auditIssuesAtLimit: issues.length >= 30, knownPagesAtLimit: candidates.length >= 40 },
    page: page ? { url: page.url, title: page.title?.slice(0, 500), description: page.description?.slice(0, 2000), statusCode: page.statusCode, canonical: page.canonical, indexable: page.indexable,
      headings: input.body ? [] : Array.isArray(page.articleHeadings) ? page.articleHeadings.filter((h): h is string => typeof h === "string").slice(0, 30).map(h => h.slice(0, 300)) : [] } : null,
    topic: cluster ? { title: cluster.title, keyword: cluster.keyword, funnel: cluster.funnel, intent: cluster.intent, pillar: cluster.pillar, brief: brief.success ? brief.data : null } : null,
    crawl: crawl ? { finishedAt: crawl.finishedAt?.toISOString() ?? null, sampleLimited: crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages } : null,
    knownPages, allowedInternalLinks: knownPages.map(p => p.url),
    issues: issues.map(({ details, ...issue }) => ({ ...issue, type: auditIssueDisplayType({ ...issue, details: details as Record<string, unknown> | null }),
      disposition: unverified(details) ? "unverified" : "observed", message: issue.message.slice(0, 1000) })), searchEvidence,
    ...(diagnostic ? { diagnosis: diagnosticSnapshot(diagnostic) } : {}) };
  if (JSON.stringify(context).length > 140000) throw new ContentError("Local evidence is too large. Choose a more specific source page or shorter pasted text.");
  return context;
}

export async function getWorkbenchWorkspace(db: WorkbenchDb, userId: string | undefined | null, siteId: string, now = new Date(), kind?: "KEYWORD_RESEARCH" | ResearchKind): Promise<WorkbenchWorkspace> {
  const site = await ownedSite(db, userId, siteId);
  await expireWorkbenchJobs(db, now, siteId);
  const crawl = await db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
  const [pages, clusters, jobs, worker, activeTask] = await Promise.all([
    crawl ? db.auditPage.findMany({ where: { crawlId: crawl.id }, orderBy: { url: "asc" }, take: 150, select: { id: true, url: true, title: true, articleText: true } }) : [],
    db.contentCluster.findMany({ where: { siteId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, title: true, keyword: true, url: true, pillar: { select: { title: true } } } }),
    db.aiWorkbenchJob.findMany({ where: { siteId, kind: kind ?? { notIn: ["KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"] } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, kind: true, title: true, status: true, createdAt: true, updatedAt: true, startedAt: true, finishedAt: true, error: true, draftText: true, result: true, context: true } }),
    db.contentWorkerState.findFirst({ orderBy: { lastSeenAt: "desc" } }),
    db.aiWorkbenchJob.findFirst({ where: { siteId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, title: true } }),
  ]);
  return { site, activeTask, worker: { online: !!worker && now.getTime() - worker.lastSeenAt.getTime() < WORKER_ONLINE_MS, lastSeenAt: worker?.lastSeenAt.toISOString() ?? null },
    pages: pages.map(({ articleText, ...page }) => ({ ...page, hasBody: (articleText?.trim().length ?? 0) >= 100 })),
    clusters: clusters.map(({ pillar, ...cluster }) => ({ ...cluster, pillarTitle: pillar.title })),
    jobs: jobs.map(({ context, ...job }) => {
      const snapshot = context && typeof context === "object" && !Array.isArray(context) ? context.diagnosis : null;
      const researchEvidence = context && typeof context === "object" && !Array.isArray(context) && isResearchAnalysis(job.kind) ? context.researchEvidence : null;
      return { ...job, ...(snapshot ? { diagnosis: snapshot as unknown as NonNullable<WorkbenchWorkspace["jobs"][number]["diagnosis"]> } : {}), ...(researchEvidence ? { researchEvidence: researchEvidence as unknown as ResearchEvidence } : {}), result: workbenchResultSchema.safeParse(job.result).data ?? null, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null };
    }) };
}

export async function runWorkbenchAction(db: WorkbenchDb, userId: string | undefined | null, siteId: string, raw: unknown, now = new Date()) {
  const site = await ownedSite(db, userId, siteId);
  const action = workbenchActionSchema.parse(raw);
  if (action.action === "start") { assertKeywordRequest(action); assertResearchRequest(action); }
  let connectionEpoch: number | undefined;
  if (action.action === "start" && action.provider === "CHATGPT_APP") {
    if (!action.planOnlyConfirmed) throw new ContentError("Confirm in ChatGPT usage settings that credit overage is disabled before generating", 409);
    if (!action.profileId || !action.model) throw new ContentError("Select a connected ChatGPT app account and model first", 409);
    connectionEpoch = (await assertPlanConnection(userId!, action.profileId)).epoch;
  }
  return db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`);
    await expireWorkbenchJobs(tx, now, siteId);
    if (action.action === "start") {
      const worker = await tx.contentWorkerState.findFirst({ where: { lastSeenAt: { gt: new Date(now.getTime() - WORKER_ONLINE_MS) } } });
      if (!worker) throw new ContentError("The local ChatGPT account worker is offline. Start the local content worker and sign in with ChatGPT.", 409);
      if (await tx.aiWorkbenchJob.count({ where: { siteId, status: { in: ["QUEUED", "RUNNING"] } } })) throw new ContentError("This site already has an active workbench task", 409);
      const { action: _action, connectionEpoch: _untrustedEpoch, ...requestInput } = action;
      const request = workbenchRequestSchema.parse({ ...requestInput, ...(connectionEpoch !== undefined ? { connectionEpoch } : {}) });
      const context = await buildContext(tx, site, request, now);
      const job = await tx.aiWorkbenchJob.create({ data: { id: `aw_${randomUUID()}`, siteId, kind: request.kind, title: request.title, request: json(request), context: json(context), activeKey: siteId, createdAt: now, updatedAt: now } });
      return { jobId: job.id };
    }
    const job = await tx.aiWorkbenchJob.findFirst({ where: { id: action.jobId, siteId } });
    if (!job) throw new ContentError("Workbench task not found", 404);
    if (action.action === "cancel") {
      const changed = await tx.aiWorkbenchJob.updateMany({ where: { id: job.id, siteId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", activeKey: null, leaseToken: null, leaseExpiresAt: null, error: CANCEL_MESSAGE, finishedAt: now, updatedAt: now } });
      if (!changed.count) throw new ContentError("Only queued or running tasks can be canceled", 409);
      return { ok: true, updatedAt: now.toISOString() };
    }
    if (job.kind === "KEYWORD_RESEARCH" || isResearchAnalysis(job.kind)) throw new ContentError("Research reports cannot be edited as article drafts", 409);
    if (job.status !== "SUCCEEDED") throw new ContentError("Only completed drafts can be edited", 409);
    const updatedAt = new Date(Math.max(now.getTime(), job.updatedAt.getTime() + 1));
    const changed = await tx.aiWorkbenchJob.updateMany({ where: { id: job.id, siteId, status: "SUCCEEDED", updatedAt: new Date(action.expectedUpdatedAt) }, data: { draftText: action.draftText, updatedAt } });
    if (!changed.count) throw new ContentError("Draft changed elsewhere. Reload before saving to avoid overwriting newer edits.", 409);
    return { ok: true, updatedAt: updatedAt.toISOString() };
  }, { timeout: 20000 });
}
