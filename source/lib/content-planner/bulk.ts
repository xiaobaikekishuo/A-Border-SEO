import type { Prisma } from "@prisma/client";
import { ContentError } from "./http";
import { importablePage, importPageColumns, sameSitePageUrl } from "./page-evidence";
import { dedupeKey } from "./schema";
import type { BulkImportResult, ContentAction } from "./types";

type Tx = Prisma.TransactionClient;
type ImportAction = Extract<ContentAction, { action: "importPages" }>;
type UpdateAction = Extract<ContentAction, { action: "bulkUpdateClusters" }>;

/** Called inside the caller's site-locked transaction. */
export async function importContentPages(tx: Tx, site: { id: string; domain: string }, action: ImportAction): Promise<BulkImportResult> {
  const pillar = await tx.contentPillar.findFirst({ where: { id: action.pillarId, siteId: site.id }, select: { id: true } });
  if (!pillar) throw new ContentError("Pillar not found", 404);
  const crawl = await tx.crawl.findFirst({ where: { siteId: site.id, status: "COMPLETED" },
    orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }], select: { id: true } });
  if (!crawl) throw new ContentError("No completed crawl is available for this site", 409);
  const ids = [...new Set(action.items.map((item) => item.pageId))];
  const pages = await tx.auditPage.findMany({ where: { id: { in: ids }, crawlId: crawl.id }, select: importPageColumns });
  if (pages.length !== ids.length) throw new ContentError("Some selected pages are no longer available in this site's latest completed crawl. Reload the page inventory.", 404);
  const eligible = new Map(pages.map((page) => [page.id, importablePage(page, site.domain)]));
  if ([...eligible.values()].some((page) => !page)) throw new ContentError("Some selected pages are not eligible same-origin HTML pages", 400);
  const [linkedRows, keywordRows] = await Promise.all([
    tx.contentCluster.findMany({ where: { siteId: site.id, url: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, url: true } }),
    tx.contentCluster.findMany({ where: { siteId: site.id, pillarId: pillar.id }, select: { id: true, dedupeKey: true } }),
  ]);
  const linked = new Map<string, string>();
  for (const row of linkedRows) {
    const url = row.url ? sameSitePageUrl(row.url, site.domain) : null;
    if (url && !linked.has(url)) linked.set(url, row.id);
  }
  const keywords = new Map(keywordRows.map((row) => [row.dedupeKey, row.id]));
  const seen = new Map<string, BulkImportResult["results"][number]>();
  const results: BulkImportResult["results"] = [];
  for (const item of action.items) {
    const previous = seen.get(item.pageId);
    if (previous) {
      results.push({ pageId: item.pageId, status: "skipped", reason: "duplicate_in_request", ...(previous.clusterId ? { clusterId: previous.clusterId } : {}) });
      continue;
    }
    const page = eligible.get(item.pageId)!;
    const existing = linked.get(page.url);
    const key = dedupeKey(item.keyword);
    let result: BulkImportResult["results"][number];
    if (existing) {
      result = { pageId: item.pageId, status: "skipped", reason: "already_linked", clusterId: existing };
    } else if (keywords.has(key)) {
      result = { pageId: item.pageId, status: "skipped", reason: "keyword_conflict", clusterId: keywords.get(key) };
    } else {
      const cluster = await tx.contentCluster.create({ data: {
        siteId: site.id, pillarId: pillar.id, title: item.title, keyword: item.keyword, dedupeKey: key,
        funnel: item.funnel, url: page.url, status: "PUBLISHED", source: "MANUAL", contentType: "Article",
      }, select: { id: true } });
      linked.set(page.url, cluster.id); keywords.set(key, cluster.id);
      result = { pageId: item.pageId, status: "imported", clusterId: cluster.id };
    }
    seen.set(item.pageId, result); results.push(result);
  }
  const imported = results.filter((row) => row.status === "imported").length;
  return { ok: true, imported, skipped: results.length - imported, results };
}

/** Every selected row moves together, or all fields stay as they were. */
export async function bulkUpdateContentClusters(tx: Tx, siteId: string, action: UpdateAction) {
  const ids = [...new Set(action.clusterIds)];
  const rows = await tx.contentCluster.findMany({ where: { id: { in: ids }, siteId }, select: { id: true, dedupeKey: true } });
  if (rows.length !== ids.length) throw new ContentError("Some selected topics were not found in this site", 404);
  if (action.data.pillarId !== undefined) {
    const target = await tx.contentPillar.findFirst({ where: { id: action.data.pillarId, siteId }, select: { id: true } });
    if (!target) throw new ContentError("Target pillar not found", 404);
    const keys = rows.map((row) => row.dedupeKey);
    if (new Set(keys).size !== keys.length || await tx.contentCluster.count({ where: {
      siteId, pillarId: target.id, id: { notIn: ids }, dedupeKey: { in: keys },
    } })) throw new ContentError("The target pillar already has one of these keywords. No topics were changed.", 409);
  }
  const changed = await tx.contentCluster.updateMany({ where: { siteId, id: { in: ids } }, data: action.data });
  if (changed.count !== ids.length) throw new ContentError("The selected topics changed during this update. Reload and try again.", 409);
  return { ok: true, updated: changed.count };
}
