import type { UpdateOutcome } from "@/lib/content-planner/update-outcome";
import type { OptimizationEvidence } from "@/lib/content-planner/optimization-evidence";
import type { ArticleReview } from "./article-review-schema";
import type { FunnelCounts } from "./funnel";
import type { z } from "zod";
import type { actionSchema, briefSchema, planSchema, workerActionSchema } from "./schema";

export type ContentBrief = z.infer<typeof briefSchema>;
export type ContentPlan = z.infer<typeof planSchema>;
export type ContentAction = z.infer<typeof actionSchema>;
export type ContentWorkerAction = z.infer<typeof workerActionSchema>;
export type ContentFunnel = "TOFU" | "MOFU" | "BOFU";
export type ContentStatus = "PLANNED" | "BRIEF_READY" | "WRITING" | "REVIEW" | "PUBLISHED";
export type ContentSource = "MANUAL" | "AI" | "EXAMPLE";
export type ContentLinkEvidence = {
  crawlAt: string; sampleLimited: boolean; pillarToCluster: boolean; clusterToPillar: boolean;
  sourceInSample: boolean; targetInSample: boolean;
};
export type MetricsPeriod = { startDate: string; endDate: string };
export type ContentMetrics = { clicks: number; impressions: number; ctr: number; position: number | null; period: MetricsPeriod };
export type ContentCluster = {
  id: string; pillarId: string; title: string; keyword: string; funnel: ContentFunnel;
  intent: string; contentType: string; status: ContentStatus; url: string | null;
  updateOutcome?: UpdateOutcome | null;
  optimization?: OptimizationEvidence | null;
  scheduledFor: string | null; brief: ContentBrief | null; source: ContentSource;
  createdAt: string; updatedAt: string; searchVolume: null; performance: ContentMetrics | null;
  linkEvidence: ContentLinkEvidence | null;
};
export type ContentPillar = {
  id: string; title: string; keyword: string; description: string; audience: string; goal: string;
  url: string | null; source: ContentSource; createdAt: string; updatedAt: string;
  searchVolume: null; performance: ContentMetrics | null; clusters: ContentCluster[];
};
export type ContentPlanJob = {
  topicCount?: number; funnelCounts?: FunnelCounts;
  kind?: string; reviewResult?: ArticleReview | null; reviewPages?: { pageId: string; title: string; url: string; source: string }[];
  id: string; pillarId: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  result: ContentPlan | null; error: string | null; appliedAt: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};
export type ContentWorkspace = {
  site: { id: string; domain: string }; pillars: ContentPillar[]; jobs: ContentPlanJob[];
  worker: { online: boolean; lastSeenAt: string | null }; metricsPeriod: MetricsPeriod | null;
};
export type ImportablePage = {
  id: string; url: string; title: string; suggestedKeyword: string; articleCandidate: boolean;
  existingClusterId?: string; existingPillarTitle?: string; hasArticleText?: boolean;
};
export type ImportablePagesResponse = {
  siteId: string;
  crawl: { id: string; finishedAt: string | null; pagesFound: number; maxPages: number; sampleLimited: boolean } | null;
  rows: ImportablePage[]; total: number; page: number; pageSize: number;
};
export type BulkImportResult = {
  ok: true; imported: number; skipped: number;
  results: {
    pageId: string; status: "imported" | "skipped";
    reason?: "already_linked" | "keyword_conflict" | "duplicate_in_request"; clusterId?: string;
  }[];
};
export const CONTENT_GLOSSARY = {
  TOFU: "Awareness: understand the problem and learn the basics.",
  MOFU: "Consideration: compare options and evaluate approaches.",
  BOFU: "Decision: resolve practical questions before taking action.",
  pillar: "A broad topic that connects related articles.",
  cluster: "A focused topic and brief linked to a pillar.",
};
