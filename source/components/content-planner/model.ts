import type { UpdateOutcome } from "@/lib/content-planner/update-outcome";
import type { OptimizationEvidence } from "@/lib/content-planner/optimization-evidence";
import type { ArticleReview } from "@/lib/content-planner/article-review-schema";
import { plannerApiError } from "./api-messages";
import { createTranslator, type Translator } from "@/lib/i18n/shared";
import type { FunnelCounts } from "@/lib/content-planner/funnel";
export type Funnel = "TOFU" | "MOFU" | "BOFU";
export type ContentStatus = "PLANNED" | "BRIEF_READY" | "WRITING" | "REVIEW" | "PUBLISHED";
export type Source = "MANUAL" | "AI" | "EXAMPLE";
export type Metrics = { clicks: number; impressions: number; ctr: number; position: number | null; period: { startDate: string; endDate: string } };
export type Brief = {
  summary: string; audience: string; searchIntent: string; angle: string;
  outline: string[]; keyPoints: string[]; cta: string;
  internalLinks: { target: string; title: string; reason: string }[]; evidenceNotes: string[];
};
export type Cluster = {
  id: string; pillarId: string; title: string; keyword: string; funnel: Funnel;
  intent: string; contentType: string; status: ContentStatus; url: string | null;
  updateOutcome?: UpdateOutcome | null;
  optimization?: OptimizationEvidence | null;
  scheduledFor: string | null; brief: Brief | null; source: Source;
  searchVolume: null; performance: Metrics | null; createdAt: string; updatedAt: string;
  linkEvidence?: { crawlAt: string; sampleLimited: boolean; pillarToCluster: boolean; clusterToPillar: boolean; sourceInSample: boolean; targetInSample: boolean } | null;
};
export type Pillar = {
  id: string; title: string; keyword: string; description: string; audience: string; goal: string;
  url: string | null; source: Source; createdAt: string; updatedAt: string;
  searchVolume: null; performance: Metrics | null; clusters: Cluster[];
};
export type PlanTopic = Pick<Cluster, "title" | "keyword" | "funnel" | "intent" | "contentType"> & { brief: Brief };
export type Plan = { pillarSummary: string; topics: PlanTopic[] };
export type PlanJob = {
  topicCount?: number; funnelCounts?: FunnelCounts;
  kind?: string; reviewResult?: ArticleReview | null; reviewPages?: { pageId: string; title: string; url: string; source: string }[];
  id: string; pillarId: string; status: string; result: Plan | null; error: string | null;
  appliedAt: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
};
export type PlannerData = {
  site: { id: string; domain: string }; pillars: Pillar[]; jobs: PlanJob[];
  worker: { online: boolean; lastSeenAt: string | null };
  metricsPeriod: { startDate: string; endDate: string } | null;
};
export type ClusterRow = Cluster & { pillarTitle: string };
export function getPlannerLabels(t: Translator = createTranslator("zh")) {
const FUNNELS: Record<Funnel, { label: string; description: string; example: string }> = {
  TOFU: { label: t("Awareness", "认识问题"), description: t("Help readers who are just starting to understand the topic.", "帮助刚开始了解的人建立基础认知。"), example: t("How do App Store and iCloud accounts differ?", "App Store 和 iCloud 账号有什么区别？") },
  MOFU: { label: t("Consideration", "比较方案"), description: t("Help readers with a clear need compare options and tradeoffs.", "帮助已经知道需求的人比较选项和取舍。"), example: t("How does using an Apple ID differ by region?", "不同 Apple ID 地区有哪些使用差异？") },
  BOFU: { label: t("Decision", "做出决策"), description: t("Help readers ready to act check requirements, steps, and risks.", "帮助准备行动的人确认条件、步骤与风险。"), example: t("What should you check before changing your Apple ID region?", "切换 Apple ID 地区前要检查哪些项目？") },
};
const STATUSES: Record<ContentStatus, string> = {
  PLANNED: t("Planned", "待规划"), BRIEF_READY: t("Brief ready", "简报就绪"), WRITING: t("Writing", "撰写中"), REVIEW: t("In review", "待审核"), PUBLISHED: t("Published", "已发布"),
};
const SOURCE_LABELS: Record<Source, string> = { MANUAL: t("Manual", "手动"), AI: t("AI planning", "AI 规划"), EXAMPLE: t("Demo example", "演示示例") };
return { FUNNELS, STATUSES, SOURCE_LABELS };
}
export const { FUNNELS, STATUSES, SOURCE_LABELS } = getPlannerLabels();
export function clusterRows(pillars: Pillar[]): ClusterRow[] {
  return pillars.flatMap(pillar => pillar.clusters.map(cluster => ({ ...cluster, pillarTitle: pillar.title })));
}
export function filterClusters(rows: ClusterRow[], filters: { query: string; pillar: string; funnel: string; status: string }): ClusterRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter(row => (!filters.pillar || row.pillarId === filters.pillar) &&
    (!filters.funnel || row.funnel === filters.funnel) && (!filters.status || row.status === filters.status) &&
    (!query || `${row.title} ${row.keyword} ${row.pillarTitle}`.toLocaleLowerCase().includes(query)));
}
export function plannerStats(pillars: Pillar[]) {
  const rows = clusterRows(pillars);
  const published = rows.filter(row => row.status === "PUBLISHED").length;
  const mapped = new Map<string, Metrics>();
  for (const item of [...pillars, ...rows]) if (item.url && item.performance) mapped.set(item.url, item.performance);
  return {
    pillars: pillars.length, clusters: rows.length, published,
    coverage: rows.length ? Math.round(published / rows.length * 100) : 0,
    mapped: mapped.size,
    clicks: mapped.size ? [...mapped.values()].reduce((sum, item) => sum + item.clicks, 0) : null,
    impressions: mapped.size ? [...mapped.values()].reduce((sum, item) => sum + item.impressions, 0) : null,
  };
}
export function runningJob(job: PlanJob) { return job.status === "QUEUED" || job.status === "RUNNING"; }
export function jobLabel(job: PlanJob, t: Translator = createTranslator("zh")): string {
  if (job.appliedAt) return t("Accepted", "已采纳");
  return ({ QUEUED: t("Queued", "等待执行"), RUNNING: t("Planning", "正在规划"), SUCCEEDED: t("Ready for review", "待你审阅"), FAILED: t("Planning incomplete", "规划未完成") } as Record<string, string>)[job.status] ?? t("Unknown status: {v0}", "未知状态：{v0}", { v0: job.status });
}
export function proposalSelectionCounts(topics: Pick<PlanTopic, "keyword">[], existing: Pick<Cluster, "keyword">[], selected: number[], updateExistingBriefs: boolean) {
  const key = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  const existingKeys = new Set(existing.map(item => key(item.keyword)));
  const existingIndexes = topics.flatMap((topic, index) => existingKeys.has(key(topic.keyword)) ? [index] : []);
  const validSelected = [...new Set(selected)].filter(index => index >= 0 && index < topics.length);
  const duplicates = validSelected.filter(index => existingIndexes.includes(index)).length;
  return { existingIndexes, added: validSelected.length - duplicates, updated: updateExistingBriefs ? duplicates : 0, skipped: updateExistingBriefs ? 0 : duplicates };
}
export function applyPlanMessage(result: { imported?: unknown; updated?: unknown; alreadyApplied?: unknown }, selectedCount: number, t: Translator = createTranslator("zh")): string {
  if (result.alreadyApplied) return t("This plan was already accepted. No duplicate additions or updates were made.", "这份规划已采纳，未重复新增或更新。");
  if (typeof result.imported !== "number" || typeof result.updated !== "number") return t("Accepted. Check article planning for the latest results.", "采纳已完成，请查看文章规划中的最新结果。");
  return t("Accepted: added {v0} topics, updated {v1} briefs, skipped {v2} duplicates.", "已采纳：新增 {v0} 个选题，更新 {v1} 份简报，跳过重复 {v2} 个。", { v0: result.imported, v1: result.updated, v2: Math.max(0, selectedCount - result.imported - result.updated) });
}
export function planErrorMessage(error: string | null, t: Translator = createTranslator("zh")): string {
  if (!error) return t("Planning did not complete. Nothing was imported. Check the local service and retry manually.", "规划未完成，尚未导入任何结果。可检查本机服务后手动重试。");
  if (error.includes("chatgpt_login_required")) return t("ChatGPT login is required. Run 登录ChatGPT.cmd locally, finish signing in, and retry.", "需要登录 ChatGPT。请在本机运行“登录ChatGPT.cmd”，完成登录后重试。");
  if (error.includes("chatgpt_usage_limit")) return t("Your ChatGPT account allowance is exhausted. No API fallback was used. Retry when your allowance resets.", "ChatGPT 账号额度不足，未切换 API。请等待额度恢复后重试。");
  if (error.includes("generation_timeout")) return t("Generation timed out. Nothing was imported. You can retry manually.", "生成超时，尚未导入结果。可以手动重试。");
  if (error.includes("invalid_model_output") || error.includes("codex_generation_failed")) return t("Generated results failed validation. No topics were accepted. Refine the pillar description and retry.", "生成结果未通过校验，未采纳任何选题。请完善主题说明后重试。");
  return t("Planning incomplete: {v0}. Nothing was imported automatically. Check the local service and retry.", "规划未完成：{v0}。尚未自动导入结果，可检查本机服务后重试。", { v0: plannerApiError(error, t) });
}
export function linkEvidenceLabel(evidence: Cluster["linkEvidence"], t: Translator = createTranslator("zh")): string {
  if (!evidence) return t("Internal links not checked", "未核验内链");
  if (evidence.pillarToCluster && evidence.clusterToPillar) return t("Bidirectional links found in sample", "样本发现双向链接");
  if (evidence.pillarToCluster || evidence.clusterToPillar) return t("One-way link found in sample", "样本发现单向链接");
  if (!evidence.sourceInSample || !evidence.targetInSample) return t("Sample does not cover both pages", "样本未覆盖两页");
  return t("No reciprocal links found in sample", "样本未发现互链");
}
export function formatCount(value: number | null | undefined, t: Translator = createTranslator("zh")): string {
  return value == null ? t("No data", "暂无数据") : new Intl.NumberFormat("zh-CN").format(value);
}
export function shortDate(value: string | null | undefined, t: Translator = createTranslator("zh")): string { return value ? value.slice(0, 10) : t("Unscheduled", "未排期"); }
export function safeSiteUrl(value: string | null | undefined, domain: string): string | null {
  if (!value) return null;
  try {
    const base = new URL(domain.startsWith("http") ? domain : `https://${domain}`);
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) && url.origin === base.origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function briefMarkdown(title: string, keyword: string, brief: Brief, t: Translator = createTranslator("zh")): string {
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : t("To be added", "待补充");
  return t("# {v0}\n\nTarget keyword: {v1}\n\n## Summary\n{v2}\n\n## Target audience\n{v3}\n\n## Search intent\n{v4}\n\n## Content angle\n{v5}\n\n## Suggested outline\n{v6}\n\n## Key points to answer\n{v7}\n\n## Call to action\n{v8}\n\n## Suggested internal links\n{v9}\n\n## Evidence and items to verify\n{v10}\n\n---\nThis is a content brief, not a completed or published article.\n", "# {v0}\n\n目标关键词：{v1}\n\n## 内容概述\n{v2}\n\n## 目标读者\n{v3}\n\n## 搜索意图\n{v4}\n\n## 内容角度\n{v5}\n\n## 建议大纲\n{v6}\n\n## 必须回答的要点\n{v7}\n\n## 行动引导\n{v8}\n\n## 建议站内链接\n{v9}\n\n## 依据与待核实项\n{v10}\n\n---\n这是内容简报，不是已完成或已发布的文章。\n", { v0: title, v1: keyword, v2: brief.summary, v3: brief.audience, v4: brief.searchIntent, v5: brief.angle, v6: list(brief.outline), v7: list(brief.keyPoints), v8: brief.cta, v9: brief.internalLinks.length ? brief.internalLinks.map(link => t("- {v0}: {v1}\n  Reason: {v2}", "- {v0}：{v1}\n  理由：{v2}", { v0: link.title, v1: link.target, v2: link.reason })).join("\n") : t("To be added", "待补充"), v10: list(brief.evidenceNotes) });
}
