import { z } from "zod";
import { articleReviewSchema } from "./article-review-schema";
import { workbenchResultSchema } from "@/lib/ai-workbench/schema";
import { aiUsageSchema } from "@/lib/ai-usage/schema";
import { validFunnelCounts } from "./funnel";

const text = (max = 500) => z.string().trim().min(1).max(max);
const optionalText = z.string().trim().max(4000).optional();
const url = z.union([z.string().trim().max(2048), z.null()]).optional();
export const funnelSchema = z.enum(["TOFU", "MOFU", "BOFU"]);
export const funnelCountsSchema = z.object({ TOFU: z.number().int().min(0).max(18), MOFU: z.number().int().min(0).max(18), BOFU: z.number().int().min(0).max(18) }).strict();
export const statusSchema = z.enum(["PLANNED", "BRIEF_READY", "WRITING", "REVIEW", "PUBLISHED"]);
export const briefSchema = z.object({
  summary: text(3000), audience: text(1500), searchIntent: text(1500), angle: text(1500),
  outline: z.array(text(800)).min(1).max(15),
  keyPoints: z.array(text(1000)).min(1).max(15),
  cta: text(1500),
  internalLinks: z.array(z.object({ target: text(2048), title: text(300), reason: text(1000) }).strict()).max(12),
  evidenceNotes: z.array(text(1500)).min(1).max(15),
}).strict();
export const topicSchema = z.object({
  title: text(250), keyword: text(250), funnel: funnelSchema,
  intent: text(300), contentType: text(150), brief: briefSchema,
}).strict();
export const planSchema = z.object({
  pillarSummary: text(4000), topics: z.array(topicSchema).min(3).max(18),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.topics.map((t) => dedupeKey(t.keyword))).size !== plan.topics.length) {
    ctx.addIssue({ code: "custom", message: "Each topic must have a distinct keyword" });
  }
});
export const pillarDataSchema = z.object({
  title: text(250), keyword: text(250), description: optionalText,
  audience: optionalText, goal: optionalText, url,
}).strict();
export const clusterDataSchema = z.object({
  title: text(250), keyword: text(250), funnel: funnelSchema,
  intent: z.string().trim().max(300).optional(), contentType: z.string().trim().min(1).max(150).optional(),
  status: statusSchema.optional(), url,
  scheduledFor: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  brief: briefSchema.nullable().optional(),
}).strict();
const id = text(200);
export const pageQuerySchema = z.object({
  query: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  articlesOnly: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).default(false),
}).strict();
const bulkUpdateDataSchema = z.object({
  pillarId: id.optional(), funnel: funnelSchema.optional(), status: statusSchema.optional(),
}).strict().refine((value) => value.pillarId !== undefined || value.funnel !== undefined || value.status !== undefined, {
  message: "Choose at least one field to update",
});
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recordWebsiteUpdate"), clusterId: id }).strict(),
  z.object({ action: z.literal("startArticleReview"), pageIds: z.array(id).min(1).max(5), pastedText: z.record(z.string(), z.string().trim().max(12000)).default({}) }).strict(),
  z.object({ action: z.literal("applyArticleReview"), jobId: id, pageIds: z.array(id).min(1).max(5) }).strict(),
  z.object({ action: z.literal("createPillar"), data: pillarDataSchema }).strict(),
  z.object({ action: z.literal("updatePillar"), pillarId: id, data: pillarDataSchema.partial() }).strict(),
  z.object({ action: z.literal("deletePillar"), pillarId: id }).strict(),
  z.object({ action: z.literal("createCluster"), pillarId: id, data: clusterDataSchema }).strict(),
  z.object({ action: z.literal("updateCluster"), clusterId: id, data: clusterDataSchema.partial() }).strict(),
  z.object({ action: z.literal("deleteCluster"), clusterId: id }).strict(),
  z.object({ action: z.literal("importPages"), pillarId: id,
    items: z.array(z.object({ pageId: id, title: text(250), keyword: text(250), funnel: funnelSchema }).strict()).min(1).max(50) }).strict(),
  z.object({ action: z.literal("bulkUpdateClusters"), clusterIds: z.array(id).min(1).max(50), data: bulkUpdateDataSchema }).strict(),
  z.object({ action: z.literal("seedExample") }).strict(),
  z.object({ action: z.literal("startPlan"), pillarId: id,
    topicCount: z.number().int().min(3).max(18).multipleOf(3).default(9), funnelCounts: funnelCountsSchema.optional() }).strict()
    .refine(value => value.funnelCounts === undefined || validFunnelCounts(value.funnelCounts, value.topicCount), { path: ["funnelCounts"], message: "Funnel counts must add up to the requested topic count" }),
  z.object({ action: z.literal("applyPlan"), jobId: id,
    topicIndexes: z.array(z.number().int().min(0).max(17)).min(1).max(18),
    updateExistingBriefs: z.boolean().default(false) }).strict(),
]);
const lease = { jobId: id, leaseToken: text(200) };
const workerUsage = aiUsageSchema.refine(value => value.source === "CODEX_CLI", "Worker usage must come from Codex CLI").nullable().optional();
export const workerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), workerId: text(100) }).strict(),
  z.object({ action: z.literal("heartbeat"), workerId: text(100), jobId: id.optional(), leaseToken: text(200).optional() }).strict(),
  z.object({ action: z.literal("complete"), ...lease, result: z.union([planSchema, articleReviewSchema, workbenchResultSchema]), usage: workerUsage }).strict(),
  z.object({ action: z.literal("fail"), ...lease, error: text(2000), usage: workerUsage }).strict(),
]);

export function dedupeKey(keyword: string): string {
  return keyword.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
export function siteUrl(value: string | null | undefined, domain: string): string | null {
  if (!value?.trim()) return null;
  const base = new URL(domain.includes("://") ? domain : `https://${domain}`);
  let parsed: URL;
  try { parsed = new URL(value, base); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== base.origin || parsed.username || parsed.password) {
    throw new Error("URLs must belong to this site's origin");
  }
  parsed.hash = "";
  return parsed.href;
}
export function validateBriefLinks(brief: z.infer<typeof briefSchema> | null | undefined, domain: string) {
  if (!brief) return brief;
  return { ...brief, internalLinks: brief.internalLinks.map((link) => ({ ...link, target: siteUrl(link.target, domain)! })) };
}
export const outputSchema = z.toJSONSchema(planSchema, { target: "draft-7" });
