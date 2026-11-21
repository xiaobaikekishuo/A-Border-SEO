import { z } from "zod";

/*
 * Request settings, model output and server fields of the structured Codex
 * tasks. A model item schema has only required fields (the output schema
 * given to Codex); the stored item adds optional fields the server fills in
 * after its checks, and ignores when the model sends them.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const intent = z.enum(["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL"]);
const funnel = z.enum(["TOFU", "MOFU", "BOFU"]);

/* ---------------------------- Titles and descriptions ---------------------------- */

export const META_LIMITS = { pages: 20, queriesPerPage: 8, title: { min: 20, max: 60 }, description: { min: 70, max: 160 } } as const;
export const metaRewriteSettingsSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(META_LIMITS.pages),
}).strict();
export const metaRewriteModelSchema = z.object({
  pageId: z.string().regex(/^P\d{1,3}$/), title: text(300), description: text(1000),
  targetQueries: z.array(text(250)).min(1).max(3), reason: text(1000),
}).strict();
export const META_WARNINGS = ["SAME_AS_CURRENT", "DUPLICATE_TITLE", "UNSUPPORTED_NUMBER", "URL_REMOVED", "NO_TARGET_QUERY"] as const;
const lengthStatus = z.enum(["OK", "LONG", "SHORT"]);
export const metaRewriteSchema = metaRewriteModelSchema.extend({
  targetQueries: z.array(z.string().max(250)).max(3),
  url: z.string().max(2048).optional(),
  currentTitle: z.string().max(1000).nullable().optional(),
  currentDescription: z.string().max(2000).nullable().optional(),
  titleUnits: z.number().int().nonnegative().optional(),
  descriptionUnits: z.number().int().nonnegative().optional(),
  titleStatus: lengthStatus.optional(),
  descriptionStatus: lengthStatus.optional(),
  coveredQueries: z.array(z.string().max(250)).max(3).optional(),
  warnings: z.array(z.enum(META_WARNINGS)).max(META_WARNINGS.length).optional(),
}).strict();
export type MetaRewrite = z.infer<typeof metaRewriteSchema>;

/* ---------------------------- Localization ---------------------------- */

export const localizationSettingsSchema = z.object({
  location: z.number().int().positive(),
  targetUrl: z.string().trim().max(2048).optional(),
}).strict();
export const localKeywordSchema = z.object({
  keyword: text(250), intent, use: text(300), note: text(800),
}).strict();
export const hreflangPlanSchema = z.object({
  code: z.string().max(20),
  sourceUrl: z.string().max(2048),
  sourceCode: z.string().max(20).nullable(),
  sourceCodeGuessed: z.boolean(),
  targetUrl: z.string().max(2048).nullable(),
  tags: z.array(z.object({ hreflang: z.string().max(20), href: z.string().max(2048) }).strict()).max(60),
  html: z.string().max(20000),
  notes: z.array(z.string().max(300)).max(10),
}).strict();
export type HreflangPlan = z.infer<typeof hreflangPlanSchema>;

/* ---------------------------- Structured data ---------------------------- */

export const SCHEMA_TYPES = ["Organization", "WebSite", "WebPage", "BreadcrumbList", "Article", "BlogPosting", "NewsArticle", "Product",
  "LocalBusiness", "SoftwareApplication", "Event", "Person", "CollectionPage", "ItemList", "Service"] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];
export const schemaMarkupSettingsSchema = z.object({ types: z.array(z.enum(SCHEMA_TYPES)).max(4) }).strict();
export const schemaBlockModelSchema = z.object({
  type: z.enum(SCHEMA_TYPES), code: text(20000),
  missing: z.array(z.object({ property: text(120), reason: text(500) }).strict()).max(12),
}).strict();
export const SCHEMA_REMOVAL_REASONS = ["NOT_ON_PAGE", "URL_NOT_ALLOWED", "IMAGE_UNKNOWN", "DATE_NOT_ON_PAGE", "TEXT_CORRECTED", "INCOMPLETE", "NOT_ALLOWED"] as const;
export const schemaReviewSchema = z.object({
  type: z.string().max(60),
  status: z.enum(["READY", "NEEDS_INPUT", "REJECTED"]),
  code: z.string().max(30000),
  html: z.string().max(31000),
  removed: z.array(z.object({ path: z.string().max(300), reason: z.enum(SCHEMA_REMOVAL_REASONS) }).strict()).max(60),
  needs: z.array(z.object({ property: z.string().max(120), reason: z.string().max(500) }).strict()).max(30),
  error: z.string().max(300).nullable(),
}).strict();
export type SchemaReview = z.infer<typeof schemaReviewSchema>;

/* ---------------------------- Outreach drafts ---------------------------- */

export const OUTREACH_LIMITS = { rows: 10, wordsWarn: 220, charsWarn: 1200 } as const;
export const outreachSettingsSchema = z.object({
  taskId: z.string().trim().min(1).max(100),
  rows: z.array(z.number().int().min(0).max(59)).min(1).max(OUTREACH_LIMITS.rows),
  senderName: text(80),
  senderRole: z.string().trim().max(160).default(""),
  offer: text(1500),
  offerPageId: z.string().trim().min(1).max(200).optional(),
}).strict();
export const outreachEmailModelSchema = z.object({
  prospectId: z.string().regex(/^R\d{1,2}$/), subject: text(200), body: text(4000),
  basis: z.array(text(400)).min(1).max(4), followUp: text(1200),
}).strict();
export const OUTREACH_WARNINGS = ["MENTIONS_PAYMENT", "LONG_BODY", "URL_REMOVED"] as const;
export const outreachEmailSchema = outreachEmailModelSchema.extend({
  domain: z.string().max(253).optional(),
  url: z.string().max(2048).optional(),
  contactUrl: z.string().max(2048).nullable().optional(),
  removedUrls: z.array(z.string().max(2048)).max(20).optional(),
  placeholders: z.array(z.string().max(80)).max(20).optional(),
  warnings: z.array(z.enum(OUTREACH_WARNINGS)).max(OUTREACH_WARNINGS.length).optional(),
}).strict();
export type OutreachEmail = z.infer<typeof outreachEmailSchema>;

/* ---------------------------- Query clusters ---------------------------- */

export const CLUSTER_LIMITS = { clusters: 40, pagesPerQuery: 3 } as const;
export const queryClusterSettingsSchema = z.object({ limit: z.union([z.literal(100), z.literal(200)]) }).strict();
export const queryClusterModelSchema = z.object({
  name: text(120), intent, funnel,
  queryIds: z.array(z.string().regex(/^Q\d{1,3}$/)).min(1).max(200),
  pageId: z.string().regex(/^P\d{1,3}$/).nullable(),
  note: text(800),
}).strict();
export const clusterReviewSchema = z.object({
  status: z.enum(["GAP", "SPLIT", "COVERED"]),
  mismatch: z.boolean(),
  queries: z.array(z.object({ query: z.string().max(500), clicks: z.number(), impressions: z.number(), position: z.number().nullable() }).strict()).max(200),
  clicks: z.number(), impressions: z.number(), position: z.number().nullable(),
  pages: z.array(z.object({ url: z.string().max(2048), title: z.string().max(500).nullable(), impressions: z.number(), share: z.number() }).strict()).max(10),
  chosenUrl: z.string().max(2048).nullable(),
  ownerUrl: z.string().max(2048).nullable(),
}).strict();
export type ClusterReview = z.infer<typeof clusterReviewSchema>;
export type QueryCluster = z.infer<typeof queryClusterModelSchema>;

// ---- TOPIC_BRIEF: a brief for a planned topic of the content plan ----
// The same shape as lib/content-planner/schema.ts briefSchema, kept here so the
// workbench schema does not import the content planner's (which imports it).

export const topicBriefSettingsSchema = z.object({ clusterId: z.string().trim().min(1).max(200) }).strict();
export const topicBriefModelSchema = z.object({
  summary: text(3000), audience: text(1500), searchIntent: text(1500), angle: text(1500),
  outline: z.array(text(800)).min(1).max(15),
  keyPoints: z.array(text(1000)).min(1).max(15),
  cta: text(1500),
  internalLinks: z.array(z.object({ target: text(2048), title: text(300), reason: text(1000) }).strict()).max(12),
  evidenceNotes: z.array(text(1500)).min(1).max(15),
}).strict();
export type TopicBrief = z.infer<typeof topicBriefModelSchema>;
