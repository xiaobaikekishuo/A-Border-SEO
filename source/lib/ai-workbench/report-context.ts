import type { Prisma } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import { siteUrl } from "@/lib/content-planner/schema";
import { actionEvidenceRevision, collectActionEvidence } from "./action-evidence";
import type { ActionScope, ReportEvidence } from "./action-scope";

/*
 * The saved evidence a report task is written from: one report scope's rows
 * and the pages of this site they name. Used when the owner starts a report
 * (lib/ai-workbench/data.ts), for the weekly action list and for background
 * reports (lib/ai-workbench/pool).
 */

type Site = { id: string; domain: string };

/** A report's task context: its evidence and the site pages the evidence names. */
export function reportContext(site: Site, reportEvidence: ReportEvidence) {
  const urls = reportEvidence.sections.flatMap(section => section.rows.map(row => {
    if (typeof row.url !== "string" || row.url.length > 2048) return null;
    try { return siteUrl(row.url, site.domain); } catch { return null; }
  }));
  return { domain: site.domain, reportEvidence, allowedInternalLinks: [...new Set(urls.filter((url): url is string => !!url))] };
}

/** Today's evidence of a report scope as a task context, with its revision. */
export async function reportJobContext(tx: Prisma.TransactionClient, site: Site, scope: ActionScope, now = new Date()) {
  const reportEvidence = await collectActionEvidence(tx, { id: site.id, domain: site.domain }, scope, now);
  if (!reportEvidence.hasData) throw new ContentError("report_evidence_empty", 409);
  return { evidenceRevision: actionEvidenceRevision(reportEvidence), context: reportContext(site, reportEvidence) };
}
