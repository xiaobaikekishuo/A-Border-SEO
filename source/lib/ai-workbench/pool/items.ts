import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { RESEARCH_LANGUAGE_VALUES, RESEARCH_LOCATIONS } from "@/lib/dataforseo/market";
import { workbenchRequestSchema, type WorkbenchRequest } from "../schema";

/*
 * Background pool items (AiBacklogItem): what each source queues and the
 * workbench task an item becomes when the worker is idle.
 */

export const POOL_SOURCES = ["RANKINGS", "ALERTS", "META", "SCHEMA", "CLUSTERS", "BRIEF", "BATCH"] as const;
export type PoolSource = (typeof POOL_SOURCES)[number];
/** Higher first: a diagnosis of what just happened before routine work. */
export const PRIORITY: Record<PoolSource, number> = { ALERTS: 90, RANKINGS: 80, META: 60, BATCH: 50, SCHEMA: 40, BRIEF: 30, CLUSTERS: 20 };

/** The server switch: AI_POOL_ENABLED=false turns background work off for the whole instance. */
export function poolServerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_POOL_ENABLED !== "false";
}

const url = z.string().min(1).max(2048);
export const itemPayloadSchemas = {
  SEO_FIX_PLAN: z.object({ scope: z.enum(["rankings", "alerts"]) }).strict(),
  META_REWRITE: z.object({ urls: z.array(url).min(1).max(20) }).strict(),
  SCHEMA_MARKUP: z.object({ url }).strict(),
  LOCALIZE_ARTICLE: z.object({ url, language: z.enum(RESEARCH_LANGUAGE_VALUES), location: z.number().int().refine(value => RESEARCH_LOCATIONS.some(item => item.value === value)) }).strict(),
  QUERY_CLUSTERS: z.object({ limit: z.union([z.literal(100), z.literal(200)]) }).strict(),
  TOPIC_BRIEF: z.object({ clusterId: z.string().min(1).max(200) }).strict(),
  // Outreach drafts for up to 10 prospects of a finished Manus link prospect task (batch work, 1.9.1),
  // in the language chosen in the outreach panel.
  OUTREACH_EMAILS: z.object({ taskId: z.string().min(1).max(100), rows: z.array(z.number().int().min(0).max(59)).min(1).max(10),
    senderName: z.string().trim().min(1).max(80), senderRole: z.string().trim().max(160), offer: z.string().trim().min(1).max(1500), offerUrl: url.nullable(),
    language: z.enum(RESEARCH_LANGUAGE_VALUES), instructions: z.string().trim().max(6000) }).strict(),
} as const;
export type ItemKind = keyof typeof itemPayloadSchemas;
export function isItemKind(kind: string): kind is ItemKind {
  return Object.hasOwn(itemPayloadSchemas, kind);
}

/** Why an item was not turned into a task. The pool view translates these codes. */
export const SKIP_REASONS = ["superseded", "expired", "yielded", "no_data", "no_search_data", "not_enough_queries", "page_gone", "has_schema",
  "no_body", "topic_gone", "has_brief", "too_large", "prepare_failed", "canceled", "prospects_changed"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export class PoolSkip extends Error {
  constructor(readonly reason: SkipReason) { super(reason); }
}

/** A ContentError message of a task builder as a skip reason. */
export function skipReasonOf(message: string): SkipReason {
  if (message === "report_evidence_empty") return "no_data";
  if (message === "meta_no_search_data") return "no_search_data";
  if (message === "cluster_not_enough_queries") return "not_enough_queries";
  if (message === "tool_context_too_large" || message === "report_claim_too_large") return "too_large";
  if (/^Page not found|Choose a crawled page|Choose pages of this site/.test(message)) return "page_gone";
  if (message === "Topic not found") return "topic_gone";
  if (/^Article body is missing/.test(message)) return "no_body";
  if (message === "outreach_task_unavailable" || message === "outreach_rows_changed") return "prospects_changed";
  return "prepare_failed";
}

export type NewItem = { source: PoolSource; kind: ItemKind; title: string; payload: Record<string, unknown>; dedupeKey: string; priority: number };

const zh = (language: string) => language.toLowerCase().startsWith("zh");
const short = (text: string, max = 80) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Item titles in the owner's pool language. */
export const itemTitle = {
  rankings: (language: string) => zh(language) ? "排名变化复盘（自动）" : "Ranking change review (auto)",
  rankingsLatest: (language: string, day: string) => zh(language) ? `排名复盘 · ${day} 的检查（手动）` : `Ranking review · check of ${day} (by hand)`,
  alerts: (language: string) => zh(language) ? "提醒诊断（自动）" : "Alert diagnosis (auto)",
  meta: (language: string, pages: number) => zh(language) ? `标题和描述（自动）· ${pages} 个页面` : `Titles and descriptions (auto) · ${pages} pages`,
  schema: (language: string, page: string, batch = false) => zh(language) ? `结构化数据（${batch ? "批量" : "自动"}）· ${short(page)}` : `Structured data (${batch ? "batch" : "auto"}) · ${short(page)}`,
  localize: (language: string, page: string, market: string) => zh(language) ? `本地化（批量）· ${market} · ${short(page)}` : `Localization (batch) · ${market} · ${short(page)}`,
  clusters: (language: string, month: string) => zh(language) ? `搜索词聚类（自动）· ${month}` : `Query clusters (auto) · ${month}`,
  brief: (language: string, topic: string, batch = false) => zh(language) ? `选题简报（${batch ? "批量" : "自动"}）· ${short(topic)}` : `Topic brief (${batch ? "batch" : "auto"}) · ${short(topic)}`,
  metaBatch: (language: string, part: number, parts: number, pages: number) => zh(language) ? `标题和描述（批量 ${part}/${parts}）· ${pages} 个页面` : `Titles and descriptions (batch ${part}/${parts}) · ${pages} pages`,
  outreach: (language: string, part: number, parts: number, prospects: number) => zh(language) ? `外链联络邮件（批量 ${part}/${parts}）· ${prospects} 个机会` : `Outreach drafts (batch ${part}/${parts}) · ${prospects} prospects`,
};

type Db = Prisma.TransactionClient;
type Item = { kind: string; title: string; payload: unknown };

/** The latest completed crawl's row of a page URL, or a skip. */
async function crawledPage(db: Db, siteId: string, pageUrl: string) {
  const crawl = await db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true } });
  const page = crawl ? await db.auditPage.findFirst({ where: { crawlId: crawl.id, url: pageUrl }, select: { id: true, hasSchema: true, articleText: true, statusCode: true } }) : null;
  if (!page || page.statusCode !== 200) throw new PoolSkip("page_gone");
  return page;
}

/**
 * The workbench request an item becomes, checked against today's data: a page
 * that got structured data meanwhile or a topic that got a brief is skipped.
 * Reports get their evidence revision when the task is created.
 */
export async function requestForItem(db: Db, site: { id: string }, item: Item, language: string): Promise<WorkbenchRequest> {
  if (!isItemKind(item.kind)) throw new PoolSkip("prepare_failed");
  const base = { provider: "CODEX_LOCAL" as const, kind: item.kind, title: item.title.slice(0, 250), language, instructions: "", keyword: "" };
  switch (item.kind) {
    case "SEO_FIX_PLAN": {
      const payload = itemPayloadSchemas.SEO_FIX_PLAN.parse(item.payload);
      return workbenchRequestSchema.parse({ ...base, actionScope: payload.scope });
    }
    case "META_REWRITE": {
      const payload = itemPayloadSchemas.META_REWRITE.parse(item.payload);
      return workbenchRequestSchema.parse({ ...base, metaRewrite: { urls: payload.urls } });
    }
    case "SCHEMA_MARKUP": {
      const payload = itemPayloadSchemas.SCHEMA_MARKUP.parse(item.payload);
      const page = await crawledPage(db, site.id, payload.url);
      if (page.hasSchema) throw new PoolSkip("has_schema");
      return workbenchRequestSchema.parse({ ...base, pageId: page.id });
    }
    case "LOCALIZE_ARTICLE": {
      const payload = itemPayloadSchemas.LOCALIZE_ARTICLE.parse(item.payload);
      const page = await crawledPage(db, site.id, payload.url);
      if ((page.articleText ?? "").trim().length < 100) throw new PoolSkip("no_body");
      return workbenchRequestSchema.parse({ ...base, language: payload.language, pageId: page.id, localization: { location: payload.location } });
    }
    case "QUERY_CLUSTERS": {
      const payload = itemPayloadSchemas.QUERY_CLUSTERS.parse(item.payload);
      return workbenchRequestSchema.parse({ ...base, queryClusters: { limit: payload.limit } });
    }
    case "TOPIC_BRIEF": {
      const payload = itemPayloadSchemas.TOPIC_BRIEF.parse(item.payload);
      const topic = await db.contentCluster.findFirst({ where: { id: payload.clusterId, siteId: site.id }, select: { brief: true } });
      if (!topic) throw new PoolSkip("topic_gone");
      if (topic.brief !== null) throw new PoolSkip("has_brief");
      return workbenchRequestSchema.parse({ ...base, topicBrief: { clusterId: payload.clusterId } });
    }
    case "OUTREACH_EMAILS": {
      const { offerUrl, language: emailLanguage, instructions, ...payload } = itemPayloadSchemas.OUTREACH_EMAILS.parse(item.payload);
      // The page to recommend, found again in the latest crawl when the task starts.
      const offerPageId = offerUrl ? (await crawledPage(db, site.id, offerUrl)).id : undefined;
      return workbenchRequestSchema.parse({ ...base, language: emailLanguage, instructions, outreach: { ...payload, ...(offerPageId ? { offerPageId } : {}) } });
    }
  }
}
