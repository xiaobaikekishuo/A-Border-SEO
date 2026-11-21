import { z } from "zod";
import type { DiagnosticEvidence } from "./diagnostic-types";
import type { ResearchEvidence } from "./research-analysis";
import { actionScopes, type ReportSource } from "./action-scope";
import { RESEARCH_LANGUAGE_VALUES } from "@/lib/dataforseo/market";
import { TOOL_KINDS } from "./tools/common";
import {
  clusterReviewSchema, hreflangPlanSchema, localizationSettingsSchema, localKeywordSchema, metaRewriteModelSchema, metaRewriteSchema,
  metaRewriteSettingsSchema, outreachEmailModelSchema, outreachEmailSchema, outreachSettingsSchema, queryClusterModelSchema,
  queryClusterSettingsSchema, schemaBlockModelSchema, schemaMarkupSettingsSchema, schemaReviewSchema, topicBriefModelSchema, topicBriefSettingsSchema,
  CLUSTER_LIMITS, META_LIMITS, OUTREACH_LIMITS,
} from "./tools/schema";

const text = (max: number) => z.string().trim().min(1).max(max);
export const diagnosticSelectionSchema = z.object({
  pageId: text(200).optional(), url: text(2048).optional(), query: text(250).optional(),
  opportunity: z.enum(["striking_distance", "low_ctr", "content_decay", "cannibalization"]).optional(),
  crawlId: text(200).optional(),
}).strict();
export const workbenchKind = z.enum(["WRITE_ARTICLE", "REWRITE_ARTICLE", "SEO_FIX_PLAN", "KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS", ...TOOL_KINDS]);
export const researchAnalysisSettingsSchema = z.object({ targetMarket: text(120) }).strict();
export const keywordResearchSettingsSchema = z.object({ count: z.union([z.literal(12), z.literal(24)]), targetMarket: text(120) }).strict();
export const keywordIdeaSchema = z.object({
  keyword: text(250), intent: z.enum(["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL"]),
  funnel: z.enum(["TOFU", "MOFU", "BOFU"]), cluster: text(200), angle: text(500), rationale: text(1500),
}).strict();
export const workbenchRequestSchema = z.object({
  provider: z.enum(["CODEX_LOCAL", "CHATGPT_APP"]).default("CODEX_LOCAL"),
  planOnlyConfirmed: z.boolean().default(false),
  connectionEpoch: z.number().int().nonnegative().optional(),
  profileId: text(200).optional(), model: z.string().regex(/^[a-zA-Z0-9._:-]{1,150}$/).optional(),
  kind: workbenchKind, title: text(250), instructions: z.string().trim().max(6000).default(""),
  keyword: z.string().trim().max(250).default(""), language: z.enum(RESEARCH_LANGUAGE_VALUES).default("zh-CN"),
  pageId: text(200).optional(), clusterId: text(200).optional(), body: z.string().trim().max(24000).default(""),
  diagnosis: diagnosticSelectionSchema.optional(),
  actionScope: z.enum(actionScopes).optional(), evidenceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  keywordResearch: keywordResearchSettingsSchema.optional(),
  researchAnalysis: researchAnalysisSettingsSchema.optional(),
  metaRewrite: metaRewriteSettingsSchema.optional(),
  localization: localizationSettingsSchema.optional(),
  schemaMarkup: schemaMarkupSettingsSchema.optional(),
  outreach: outreachSettingsSchema.optional(),
  queryClusters: queryClusterSettingsSchema.optional(),
  topicBrief: topicBriefSettingsSchema.optional(),
  // Set by the server on the weekly action list it queues (lib/ai-workbench/weekly-report.ts), never by a request.
  schedule: z.literal("WEEKLY").optional(),
}).strict();
export const workbenchActionSchema = z.discriminatedUnion("action", [
  workbenchRequestSchema.extend({ action: z.literal("start") }),
  z.object({ action: z.literal("saveDraft"), jobId: text(200), expectedUpdatedAt: z.iso.datetime({ offset: true }), draftText: z.string().max(60000) }).strict(),
  z.object({ action: z.literal("cancel"), jobId: text(200) }).strict(),
]);
export const paragraphEditSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  sourceText: z.string().min(10).max(8000), replacementText: z.string().max(10000),
  reason: text(1500), evidence: z.array(text(1500)).min(1).max(8), verification: z.array(text(1500)).min(1).max(8),
}).strict();
const reportActionSchema = z.object({
  title: text(250), reason: text(1000), nextStep: text(1500), verify: text(1000),
  evidenceRefs: z.array(text(100)).min(1).max(6),
}).strict();
/** A link of a finished draft that is neither a verified site page nor a trusted source (lib/ai-workbench/link-review.ts). Added by the server, never by the model. */
export const linkReviewEntrySchema = z.object({
  url: z.string().max(2048), field: z.string().max(40),
  status: z.enum(["UNVERIFIED", "UNSAFE"]), action: z.enum(["REPLACED", "DROPPED", "KEPT_IN_NOTES", "KEPT_IN_CODE"]), context: z.string().max(160),
}).strict();
export type LinkReviewEntry = z.infer<typeof linkReviewEntrySchema>;
export const workbenchResultSchema = z.object({
  title: text(250), summary: text(3000), contentMarkdown: text(50000),
  metaTitle: z.string().trim().max(300), metaDescription: z.string().trim().max(1000),
  changeNotes: z.array(text(1500)).max(20), factChecks: z.array(text(1500)).min(1).max(20),
  internalLinks: z.array(z.object({ target: text(2048), anchor: text(300), reason: text(1000) }).strict()).max(20),
  paragraphEdits: z.array(paragraphEditSchema).max(12).optional(),
  keywordIdeas: z.array(keywordIdeaSchema).max(24).optional(),
  reportActions: z.array(reportActionSchema).max(3).optional(),
  linkReview: z.array(linkReviewEntrySchema).max(50).optional(),
  // Structured tasks (lib/ai-workbench/tools). hreflang, schemaReview and clusterReview are the server's.
  metaRewrites: z.array(metaRewriteSchema).max(META_LIMITS.pages).optional(),
  localKeywords: z.array(localKeywordSchema).max(12).optional(),
  hreflang: hreflangPlanSchema.optional(),
  schemaBlocks: z.array(schemaBlockModelSchema).max(4).optional(),
  schemaReview: z.array(schemaReviewSchema).max(4).optional(),
  outreachEmails: z.array(outreachEmailSchema).max(OUTREACH_LIMITS.rows).optional(),
  queryClusters: z.array(queryClusterModelSchema).max(CLUSTER_LIMITS.clusters + 1).optional(),
  clusterReview: z.array(clusterReviewSchema).max(CLUSTER_LIMITS.clusters + 1).optional(),
  topicBrief: topicBriefModelSchema.optional(),
}).strict();
// Inference uses a required array; historical stored results may omit it. linkReview is the server's, not the model's.
export const workbenchGenerationSchema = workbenchResultSchema.omit({ keywordIdeas: true, reportActions: true, linkReview: true,
  metaRewrites: true, localKeywords: true, hreflang: true, schemaBlocks: true, schemaReview: true, outreachEmails: true, queryClusters: true, clusterReview: true,
  topicBrief: true,
}).extend({ paragraphEdits: z.array(paragraphEditSchema).max(12) });
export const keywordResearchGenerationSchema = workbenchGenerationSchema.extend({ keywordIdeas: z.array(keywordIdeaSchema).min(1).max(24) });
const reportGenerationSchema = workbenchGenerationSchema.extend({ reportActions: z.array(reportActionSchema).max(3) });
const toolGenerationSchemas = {
  META_REWRITE: workbenchGenerationSchema.extend({ metaRewrites: z.array(metaRewriteModelSchema).min(1).max(META_LIMITS.pages) }),
  LOCALIZE_ARTICLE: workbenchGenerationSchema.extend({ localKeywords: z.array(localKeywordSchema).min(1).max(12) }),
  SCHEMA_MARKUP: workbenchGenerationSchema.extend({ schemaBlocks: z.array(schemaBlockModelSchema).min(1).max(4) }),
  OUTREACH_EMAILS: workbenchGenerationSchema.extend({ outreachEmails: z.array(outreachEmailModelSchema).min(1).max(OUTREACH_LIMITS.rows) }),
  QUERY_CLUSTERS: workbenchGenerationSchema.extend({ queryClusters: z.array(queryClusterModelSchema).min(1).max(CLUSTER_LIMITS.clusters) }),
  TOPIC_BRIEF: workbenchGenerationSchema.extend({ topicBrief: topicBriefModelSchema }),
} as const;
export function generationSchemaFor(kind: string, actionScope?: string) {
  if (kind === "SEO_FIX_PLAN" && actionScope) return reportGenerationSchema;
  if (Object.hasOwn(toolGenerationSchemas, kind)) return toolGenerationSchemas[kind as keyof typeof toolGenerationSchemas];
  return kind === "KEYWORD_RESEARCH" ? keywordResearchGenerationSchema : workbenchGenerationSchema;
}
export type WorkbenchRequest = z.infer<typeof workbenchRequestSchema>;
export type WorkbenchResult = z.infer<typeof workbenchResultSchema>;

export type WorkbenchJobView = {
  id: string; kind: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  title: string; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; draftText: string | null; result: WorkbenchResult | null;
  diagnosis?: Omit<DiagnosticEvidence, "pages" | "page"> & { page: Omit<NonNullable<DiagnosticEvidence["page"]>, "body"> | null };
  researchEvidence?: ResearchEvidence;
  reportSources?: ReportSource[];
};
export type WorkbenchWorkspace = {
  site: { id: string; domain: string };
  worker: { online: boolean; lastSeenAt: string | null };
  pages: { id: string; url: string; title: string | null; hasBody: boolean; hasSchema: boolean }[];
  clusters: { id: string; title: string; keyword: string; url: string | null; pillarTitle: string }[];
  jobs: WorkbenchJobView[];
  /** background: a task of the background pool, which gives way when the owner starts one. */
  activeTask?: { id: string; kind: string; title: string; background?: boolean } | null;
};
