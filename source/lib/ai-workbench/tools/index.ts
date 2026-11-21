import type { Prisma } from "@prisma/client";
import { ContentError } from "@/lib/content-planner/http";
import type { WorkbenchRequest, WorkbenchResult } from "../schema";
import { isToolKind, type ToolKind } from "./common";
import { buildMetaContext, metaRewritePrompt, reviewMetaRewrites, type MetaContext } from "./meta-rewrite";
import { buildLocalizeContext, localizePrompt, reviewLocalization, type LocalizeContext } from "./localize";
import { buildSchemaContext, reviewSchemaResult, schemaMarkupPrompt, type SchemaContext } from "./schema-markup";
import { buildOutreachContext, outreachPrompt, reviewOutreach, type OutreachContext } from "./outreach";
import { buildClusterContext, clusterPrompt, reviewClusters, type ClusterContext } from "./query-clusters";
import { buildBriefContext, reviewTopicBrief, topicBriefPrompt, type BriefContext } from "./topic-brief";

export { isToolKind, isPanelKind, PANEL_KINDS, TOOL_KINDS, type PanelKind, type ToolKind } from "./common";

const SETTINGS = {
  META_REWRITE: "metaRewrite", LOCALIZE_ARTICLE: "localization", SCHEMA_MARKUP: "schemaMarkup",
  OUTREACH_EMAILS: "outreach", QUERY_CLUSTERS: "queryClusters", TOPIC_BRIEF: "topicBrief",
} as const satisfies Record<ToolKind, keyof WorkbenchRequest>;
const RESULT_FIELDS: Record<ToolKind, (keyof WorkbenchResult)[]> = {
  META_REWRITE: ["metaRewrites"], LOCALIZE_ARTICLE: ["localKeywords", "hreflang"], SCHEMA_MARKUP: ["schemaBlocks", "schemaReview"],
  OUTREACH_EMAILS: ["outreachEmails"], QUERY_CLUSTERS: ["queryClusters", "clusterReview"], TOPIC_BRIEF: ["topicBrief"],
};

/** The settings of a structured task only with its own kind, and what each kind needs. */
export function assertToolRequest(input: WorkbenchRequest) {
  for (const [kind, field] of Object.entries(SETTINGS)) {
    if (input[field] !== undefined && input.kind !== kind) throw new ContentError("These settings belong to another task type", 400);
  }
  if (!isToolKind(input.kind)) return;
  if (input.actionScope || input.evidenceRevision || input.diagnosis || input.keywordResearch || input.researchAnalysis || input.clusterId || input.schedule) {
    throw new ContentError("Invalid settings for this task", 400);
  }
  if (input.kind !== "SCHEMA_MARKUP" && input[SETTINGS[input.kind]] === undefined) throw new ContentError("Missing settings for this task", 400);
  if (input.kind === "SCHEMA_MARKUP" && !input.pageId) throw new ContentError("Choose a crawled page", 400);
  if (input.kind !== "LOCALIZE_ARTICLE" && input.kind !== "SCHEMA_MARKUP" && input.pageId) throw new ContentError("Invalid settings for this task", 400);
  if (input.kind !== "LOCALIZE_ARTICLE" && input.body) throw new ContentError("Pasted text is only used for localization", 400);
}

export async function buildToolContext(db: Prisma.TransactionClient, site: { id: string; domain: string }, input: WorkbenchRequest, now = new Date()) {
  switch (input.kind) {
    case "META_REWRITE": return buildMetaContext(db, site, input, now);
    case "LOCALIZE_ARTICLE": return buildLocalizeContext(db, site, input);
    case "SCHEMA_MARKUP": return buildSchemaContext(db, site, input);
    case "OUTREACH_EMAILS": return buildOutreachContext(db, site, input);
    case "QUERY_CLUSTERS": return buildClusterContext(db, site, input, now);
    case "TOPIC_BRIEF": return buildBriefContext(db, site, input);
    default: throw new ContentError("Unknown task type", 400);
  }
}

export function toolPrompt(input: WorkbenchRequest, context: unknown): string {
  switch (input.kind) {
    case "META_REWRITE": return metaRewritePrompt(input, context as MetaContext);
    case "LOCALIZE_ARTICLE": return localizePrompt(input, context as LocalizeContext);
    case "SCHEMA_MARKUP": return schemaMarkupPrompt(input, context as SchemaContext);
    case "OUTREACH_EMAILS": return outreachPrompt(input, context as OutreachContext);
    case "QUERY_CLUSTERS": return clusterPrompt(input, context as ClusterContext);
    case "TOPIC_BRIEF": return topicBriefPrompt(input, context as BriefContext);
    default: throw new ContentError("Unknown task type", 400);
  }
}

/** Fields of a structured task only in a result of that kind. */
export function assertToolFields(kind: string, result: WorkbenchResult) {
  for (const [toolKind, fields] of Object.entries(RESULT_FIELDS)) {
    if (toolKind !== kind && fields.some(field => result[field] !== undefined)) throw new ContentError("The result has fields of another task type", 400);
  }
}

/** The program's checks of a structured result. Fields the server owns are dropped first, then filled in. */
export function reviewToolResult(kind: ToolKind, result: WorkbenchResult, context: unknown, language: string): WorkbenchResult {
  const { hreflang: _hreflang, schemaReview: _schemaReview, clusterReview: _clusterReview, ...model } = result;
  switch (kind) {
    case "META_REWRITE": return reviewMetaRewrites(model, context);
    case "LOCALIZE_ARTICLE": return reviewLocalization(model, context);
    case "SCHEMA_MARKUP": return reviewSchemaResult(model, context, language);
    case "OUTREACH_EMAILS": return reviewOutreach(model, context, language);
    case "QUERY_CLUSTERS": return reviewClusters(model, context, language);
    case "TOPIC_BRIEF": return reviewTopicBrief(model, context);
  }
}
