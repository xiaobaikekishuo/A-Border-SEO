import { z } from "zod";
import type { DiagnosticEvidence } from "./diagnostic-types";
import type { ResearchEvidence } from "./research-analysis";

const text = (max: number) => z.string().trim().min(1).max(max);
export const diagnosticSelectionSchema = z.object({
  pageId: text(200).optional(), url: text(2048).optional(), query: text(250).optional(),
  opportunity: z.enum(["striking_distance", "low_ctr", "content_decay", "cannibalization"]).optional(),
  crawlId: text(200).optional(),
}).strict();
export const workbenchKind = z.enum(["WRITE_ARTICLE", "REWRITE_ARTICLE", "SEO_FIX_PLAN", "KEYWORD_RESEARCH", "DOMAIN_ANALYSIS", "BACKLINK_ANALYSIS"]);
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
  keyword: z.string().trim().max(250).default(""), language: z.enum(["zh-CN", "en"]).default("zh-CN"),
  pageId: text(200).optional(), clusterId: text(200).optional(), body: z.string().trim().max(24000).default(""),
  diagnosis: diagnosticSelectionSchema.optional(),
  keywordResearch: keywordResearchSettingsSchema.optional(),
  researchAnalysis: researchAnalysisSettingsSchema.optional(),
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
export const workbenchResultSchema = z.object({
  title: text(250), summary: text(3000), contentMarkdown: text(50000),
  metaTitle: z.string().trim().max(300), metaDescription: z.string().trim().max(1000),
  changeNotes: z.array(text(1500)).max(20), factChecks: z.array(text(1500)).min(1).max(20),
  internalLinks: z.array(z.object({ target: text(2048), anchor: text(300), reason: text(1000) }).strict()).max(20),
  paragraphEdits: z.array(paragraphEditSchema).max(12).optional(),
  keywordIdeas: z.array(keywordIdeaSchema).max(24).optional(),
}).strict();
// Inference uses a required array; historical stored results may omit it.
export const workbenchGenerationSchema = workbenchResultSchema.omit({ keywordIdeas: true }).extend({ paragraphEdits: z.array(paragraphEditSchema).max(12) });
export const keywordResearchGenerationSchema = workbenchGenerationSchema.extend({ keywordIdeas: z.array(keywordIdeaSchema).min(1).max(24) });
export function generationSchemaFor(kind: string) { return kind === "KEYWORD_RESEARCH" ? keywordResearchGenerationSchema : workbenchGenerationSchema; }
export type WorkbenchRequest = z.infer<typeof workbenchRequestSchema>;
export type WorkbenchResult = z.infer<typeof workbenchResultSchema>;

export type WorkbenchJobView = {
  id: string; kind: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  title: string; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; draftText: string | null; result: WorkbenchResult | null;
  diagnosis?: Omit<DiagnosticEvidence, "pages" | "page"> & { page: Omit<NonNullable<DiagnosticEvidence["page"]>, "body"> | null };
  researchEvidence?: ResearchEvidence;
};
export type WorkbenchWorkspace = {
  site: { id: string; domain: string };
  worker: { online: boolean; lastSeenAt: string | null };
  pages: { id: string; url: string; title: string | null; hasBody: boolean }[];
  clusters: { id: string; title: string; keyword: string; url: string | null; pillarTitle: string }[];
  jobs: WorkbenchJobView[];
  activeTask?: { id: string; kind: string; title: string } | null;
};
